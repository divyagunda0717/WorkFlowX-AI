import bcrypt from "bcrypt";
import { Router, type Request } from "express";
import {
  CreateWorkflowBody,
  LoginBody,
  RegisterBody,
  UpdateTaskBody,
  UpdateWorkflowBody,
} from "@workspace/api-zod";
import { Types } from "mongoose";
import { z } from "zod";
import { createAccessToken, getAuthenticatedUserId, requireAuth } from "./auth";
import {
  runAnalysisAgent,
  runCoordinationAgent,
  runPlanningAgent,
  runReplanningAgent,
  type PlannedTask,
  type WorkflowAnalysis,
} from "./agents";
import { ensureMongoConnection } from "./database";
import { HttpError } from "./errors";
import {
  AgentLogModel,
  ApprovalModel,
  NotificationModel,
  TaskModel,
  UserModel,
  WorkflowModel,
  type AgentLogDocument,
  type ApprovalDocument,
  type TaskDocument,
  type UserDocument,
  type WorkflowDocument,
} from "./models";

const router = Router();
const approvalDecisionSchema = z.object({
  reason: z.string().max(1000).optional(),
});

router.use(async (_request, _response, next) => {
  try {
    await ensureMongoConnection();
    next();
  } catch (error) {
    next(error);
  }
});

function publicUser(user: UserDocument) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

function toTask(task: TaskDocument) {
  return {
    id: task._id.toString(),
    workflowId: task.workflowId.toString(),
    title: task.title,
    description: task.description,
    assignedAgent: task.assignedAgent,
    priority: task.priority,
    status: task.status,
    dependencies: task.dependencies ?? [],
    requiresApproval: task.requiresApproval,
    deadline: task.deadline?.toISOString() ?? null,
    estimatedMinutes: task.estimatedMinutes,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function toLog(log: AgentLogDocument) {
  return {
    id: log._id.toString(),
    workflowId: log.workflowId.toString(),
    agentName: log.agentName,
    action: log.action,
    status: log.status,
    summary: log.summary,
    timestamp: log.timestamp.toISOString(),
  };
}

function toApproval(approval: ApprovalDocument) {
  return {
    id: approval._id.toString(),
    workflowId: approval.workflowId.toString(),
    taskId: approval.taskId?.toString() ?? null,
    action: approval.action,
    reason: approval.reason,
    recommendation: approval.recommendation,
    status: approval.status,
    decidedBy: approval.decidedBy ?? null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt?.toISOString() ?? null,
  };
}

function toWorkflow(workflow: WorkflowDocument, tasks: TaskDocument[]) {
  const completedTaskCount = tasks.filter((task) => task.status === "Completed").length;
  const progress =
    tasks.length === 0 ? 0 : Math.round((completedTaskCount / tasks.length) * 100);
  return {
    id: workflow._id.toString(),
    title: workflow.title,
    description: workflow.description,
    department: workflow.department,
    category: workflow.category,
    priority: workflow.priority,
    impact: workflow.impact,
    status: workflow.status,
    currentStep: workflow.currentStep,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
    deadline: workflow.deadline?.toISOString() ?? null,
    progress,
    taskCount: tasks.length,
    completedTaskCount,
    requiresApproval: workflow.requiresApproval,
  };
}

function validId(id: string, entity: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new HttpError(404, `${entity} not found.`);
  }
  return new Types.ObjectId(id);
}

async function ownedWorkflow(
  workflowId: string,
  ownerId: string,
): Promise<WorkflowDocument> {
  const workflow = await WorkflowModel.findOne({
    _id: validId(workflowId, "Workflow"),
    ownerId: validId(ownerId, "User"),
  });
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  return workflow;
}

async function ownedTask(taskId: string, ownerId: string): Promise<TaskDocument> {
  const task = await TaskModel.findById(validId(taskId, "Task"));
  if (!task) throw new HttpError(404, "Task not found.");
  await ownedWorkflow(task.workflowId.toString(), ownerId);
  return task;
}

async function workflowDetail(workflow: WorkflowDocument, ownerId: string) {
  const [tasks, activity, approvals] = await Promise.all([
    TaskModel.find({ workflowId: workflow._id }).sort({ createdAt: 1 }),
    AgentLogModel.find({ workflowId: workflow._id })
      .sort({ timestamp: -1 })
      .limit(60),
    ApprovalModel.find({ workflowId: workflow._id }).sort({ createdAt: -1 }),
  ]);
  const owned = await ownedWorkflow(workflow._id.toString(), ownerId);
  return {
    workflow: toWorkflow(owned, tasks),
    analysis: (owned.aiAnalysis as WorkflowAnalysis | null) ?? null,
    tasks: tasks.map(toTask),
    activity: activity.map(toLog),
    approvals: approvals.map(toApproval),
  };
}

async function writeLog(
  workflowId: Types.ObjectId,
  agentName: string,
  action: string,
  summary: string,
  status = "completed",
) {
  await AgentLogModel.create({
    workflowId,
    agentName,
    action,
    status,
    summary: summary.slice(0, 1200),
  });
}

async function ownedWorkflowIds(ownerId: string): Promise<Types.ObjectId[]> {
  const workflows = await WorkflowModel.find({ ownerId: validId(ownerId, "User") })
    .select("_id");
  return workflows.map((workflow) => workflow._id);
}

function needsHumanApproval(task: PlannedTask): boolean {
  return (
    task.requiresApproval ||
    /\b(refund|chargeback|issue credit|delete account|terminate|wire transfer)\b/i.test(
      `${task.title} ${task.description}`,
    )
  );
}

async function savePlannedTasks(
  workflow: WorkflowDocument,
  ownerId: string,
  tasks: PlannedTask[],
  options: { replannedFrom?: Types.ObjectId; omitDependencyTitle?: string } = {},
) {
  const createdTasks: TaskDocument[] = [];
  for (const planned of tasks) {
    const dependencies = (planned.dependencies ?? []).filter(
      (dependency) => dependency !== options.omitDependencyTitle,
    );
    const task = await TaskModel.create({
      workflowId: workflow._id,
      title: planned.title,
      description: planned.description,
      assignedAgent: planned.assignedAgent,
      priority: planned.priority,
      status: "Pending",
      dependencies,
      requiresApproval: needsHumanApproval(planned),
      deadline: workflow.deadline ?? null,
      estimatedMinutes: planned.estimatedMinutes,
      replannedFrom: options.replannedFrom ?? null,
    });
    createdTasks.push(task);

    if (task.requiresApproval) {
      const approval = await ApprovalModel.create({
        workflowId: workflow._id,
        taskId: task._id,
        action: task.title,
        reason:
          (workflow.aiAnalysis as WorkflowAnalysis | null)?.summary ??
          workflow.description,
        recommendation: `AI recommendation: ${task.description}`,
        status: "pending",
      });
      await NotificationModel.create({
        userId: validId(ownerId, "User"),
        workflowId: workflow._id,
        message: `Approval required: ${approval.action}`,
        type: "approval",
      });
    }
  }
  return createdTasks;
}

function taskIsResolved(task: TaskDocument, tasks: TaskDocument[]): boolean {
  if (task.status === "Completed") return true;
  if (task.status !== "Failed" && task.status !== "Blocked") return false;
  const replacements = tasks.filter(
    (candidate) => candidate.replannedFrom?.toString() === task._id.toString(),
  );
  return replacements.length > 0 && replacements.every((replacement) =>
    taskIsResolved(replacement, tasks),
  );
}

async function startNextReadyTask(
  workflow: WorkflowDocument,
  tasks: TaskDocument[],
): Promise<"started" | "approval" | "blocked" | "complete"> {
  const activeTask = tasks.find((task) => task.status === "In Progress");
  if (activeTask) {
    workflow.status = "executing";
    workflow.currentStep = `Executing: ${activeTask.title}`;
    await workflow.save();
    return "started";
  }

  const completedTitles = new Set(
    tasks.filter((task) => task.status === "Completed").map((task) => task.title),
  );
  const nextTask = tasks.find(
    (task) =>
      task.status === "Pending" &&
      (task.dependencies ?? []).every((dependency) => completedTitles.has(dependency)),
  );

  if (!nextTask) {
    const unresolvedTasks = tasks.filter((task) => !taskIsResolved(task, tasks));
    if (
      unresolvedTasks.some(
        (task) => task.status === "Failed" || task.status === "Blocked",
      )
    ) {
      workflow.status = "blocked";
      workflow.currentStep = "Waiting for a blocked task to be resolved";
      await workflow.save();
      return "blocked";
    }
    if (unresolvedTasks.some((task) => task.status === "Pending")) {
      workflow.status = "blocked";
      workflow.currentStep = "Waiting for unresolved task dependencies";
      await workflow.save();
      return "blocked";
    }
    const pendingApproval = await ApprovalModel.findOne({
      workflowId: workflow._id,
      status: "pending",
    });
    if (pendingApproval) {
      workflow.status = "awaiting_approval";
      workflow.currentStep = "Waiting for human approval";
      await workflow.save();
      return "approval";
    }
    workflow.status = "completed";
    workflow.currentStep = "All tasks completed";
    await workflow.save();
    return "complete";
  }

  if (nextTask.requiresApproval) {
    const approval = await ApprovalModel.findOne({
      taskId: nextTask._id,
      status: "pending",
    });
    if (approval) {
      workflow.status = "awaiting_approval";
      workflow.currentStep = "Waiting for human approval";
      await workflow.save();
      return "approval";
    }
  }

  nextTask.status = "In Progress";
  await nextTask.save();
  workflow.status = "executing";
  workflow.currentStep = `Executing: ${nextTask.title}`;
  await workflow.save();
  await writeLog(
    workflow._id,
    "Execution Agent",
    "Started task",
    `${nextTask.assignedAgent} started “${nextTask.title}”.`,
  );
  await writeLog(
    workflow._id,
    "Monitoring Agent",
    "Monitoring active task",
    `Monitoring progress and dependencies for “${nextTask.title}”.`,
  );
  return "started";
}

async function createWorkflowFromInput(
  ownerId: string,
  input: {
    title: string;
    description: string;
    department?: string;
    deadline?: Date | string | null;
  },
  startImmediately: boolean,
) {
  const normalized = {
    title: input.title.trim(),
    description: input.description.trim(),
    department: input.department?.trim() || "Operations",
  };

  await ensureMongoConnection();
  const analysis = await runAnalysisAgent(normalized);
  const draftTasks = await runPlanningAgent(normalized, analysis);
  const tasks = await runCoordinationAgent(draftTasks, normalized.department);
  const workflow = await WorkflowModel.create({
    ownerId: validId(ownerId, "User"),
    title: normalized.title,
    description: normalized.description,
    department: normalized.department,
    category: analysis.category,
    priority: analysis.priority,
    impact: analysis.impact,
    status: "ready",
    currentStep: "Ready for execution",
    aiAnalysis: analysis,
    requiresApproval: tasks.some(needsHumanApproval),
    deadline: input.deadline
      ? input.deadline instanceof Date
        ? input.deadline
        : new Date(input.deadline)
      : null,
  });

  await writeLog(
    workflow._id,
    "Orchestrator",
    "Workflow received",
    `Received “${workflow.title}” and selected the analysis, planning, and coordination agents.`,
  );
  await writeLog(
    workflow._id,
    "Analysis Agent",
    "Analyzed business issue",
    `${analysis.category} · ${analysis.priority} priority · ${analysis.impact} impact. ${analysis.summary}`,
  );
  await writeLog(
    workflow._id,
    "Task Planning Agent",
    "Created execution plan",
    `Converted the analysis into ${tasks.length} actionable tasks.`,
  );
  const savedTasks = await savePlannedTasks(workflow, ownerId, tasks);
  await writeLog(
    workflow._id,
    "Coordination Agent",
    "Assigned specialists",
    `Assigned ${savedTasks.length} tasks across ${new Set(tasks.map((task) => task.assignedAgent)).size} specialist agents.`,
  );
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Plan ready",
    tasks.some(needsHumanApproval)
      ? "The workflow is ready. A high-impact action will pause for human approval."
      : "The workflow is ready to execute.",
  );

  if (startImmediately) {
    await startNextReadyTask(workflow, savedTasks);
  }
  return workflowDetail(workflow, ownerId);
}

async function runReplan(
  workflow: WorkflowDocument,
  ownerId: string,
  task: TaskDocument,
  reason: string,
) {
  workflow.status = "replanning";
  workflow.currentStep = "Analyzing failure and preparing an alternative";
  await workflow.save();
  await writeLog(
    workflow._id,
    "Monitoring Agent",
    "Detected task failure",
    `Detected that “${task.title}” could not continue. ${reason}`,
    "warning",
  );
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Requested autonomous replan",
    "The orchestrator asked the Replanning Agent to find a safe alternative.",
  );

  const allTasks = await TaskModel.find({ workflowId: workflow._id }).sort({
    createdAt: 1,
  });
  let replan;
  try {
    replan = await runReplanningAgent({
      workflowTitle: workflow.title,
      analysis: (workflow.aiAnalysis as WorkflowAnalysis | null) ?? null,
      failedTask: {
        title: task.title,
        description: task.description,
        assignedAgent: task.assignedAgent,
      },
      failureReason: reason,
      remainingTasks: allTasks
        .filter((item) => item._id.toString() !== task._id.toString())
        .map((item) => ({
          title: item.title,
          status: item.status,
          assignedAgent: item.assignedAgent,
        })),
    });
  } catch (error) {
    workflow.status = "blocked";
    workflow.currentStep = "Replanning needs attention";
    await workflow.save();
    await writeLog(
      workflow._id,
      "Replanning Agent",
      "Could not generate an alternative",
      "The AI service did not return a valid replacement plan. The workflow is blocked until it can be retried.",
      "failed",
    );
    throw error;
  }

  const replacements = await savePlannedTasks(workflow, ownerId, replan.newPlan, {
    replannedFrom: task._id,
    omitDependencyTitle: task.title,
  });
  task.status = "Failed";
  await task.save();
  const replacementTitles = replacements.map((replacement) => replacement.title);
  const downstreamTasks = await TaskModel.find({
    workflowId: workflow._id,
    _id: { $nin: [task._id, ...replacements.map((replacement) => replacement._id)] },
    status: { $in: ["Pending", "Blocked"] },
    dependencies: task.title,
  });
  for (const downstreamTask of downstreamTasks) {
    downstreamTask.dependencies = [
      ...new Set([
        ...downstreamTask.dependencies.filter(
          (dependency: string) => dependency !== task.title,
        ),
        ...replacementTitles,
      ]),
    ];
    await downstreamTask.save();
  }
  workflow.replannedAt = new Date();
  workflow.requiresApproval =
    workflow.requiresApproval || replacements.some((replacement) => replacement.requiresApproval);
  workflow.status = "executing";
  workflow.currentStep = "Continuing with the revised plan";
  await workflow.save();

  await writeLog(
    workflow._id,
    "Replanning Agent",
    "Generated an alternative plan",
    `${replan.reason} ${replan.escalationRequired ? "Escalated to the Manager Agent." : ""}`,
  );
  await writeLog(
    workflow._id,
    "Coordination Agent",
    "Reassigned replacement work",
    `Created ${replacements.length} replacement task${replacements.length === 1 ? "" : "s"} and assigned ${new Set(replacements.map((item) => item.assignedAgent)).size} specialist agent${new Set(replacements.map((item) => item.assignedAgent)).size === 1 ? "" : "s"}.`,
  );

  const latestTasks = await TaskModel.find({ workflowId: workflow._id }).sort({
    createdAt: 1,
  });
  await startNextReadyTask(workflow, latestTasks);
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Workflow continuing",
    "The revised plan is in place and the workflow has resumed.",
  );
}

router.post("/auth/register", async (request, response) => {
  const input = RegisterBody.parse(request.body);
  const email = input.email.trim().toLowerCase();
  const existing = await UserModel.findOne({ email }).select("_id");
  if (existing) throw new HttpError(409, "An account with this email already exists.");

  const user = await UserModel.create({
    name: input.name.trim(),
    email,
    passwordHash: await bcrypt.hash(input.password, 12),
    role: "user",
  });
  response.status(201).json({
    token: createAccessToken(user._id.toString()),
    user: publicUser(user),
  });
});

router.post("/auth/login", async (request, response) => {
  const input = LoginBody.parse(request.body);
  const user = await UserModel.findOne({
    email: input.email.trim().toLowerCase(),
  }).select("+passwordHash");
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  response.json({
    token: createAccessToken(user._id.toString()),
    user: publicUser(user),
  });
});

router.use(requireAuth);

router.get("/auth/me", async (request, response) => {
  const user = await UserModel.findById(
    validId(getAuthenticatedUserId(request), "User"),
  );
  if (!user) throw new HttpError(401, "Your account could not be found.");
  response.json(publicUser(user));
});

router.get("/workflows", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflows = await WorkflowModel.find({ ownerId: validId(ownerId, "User") })
    .sort({ updatedAt: -1 })
    .limit(100);
  const result = await Promise.all(
    workflows.map(async (workflow) => {
      const tasks = await TaskModel.find({ workflowId: workflow._id });
      return toWorkflow(workflow, tasks);
    }),
  );
  response.json(result);
});

router.post("/workflows", async (request, response) => {
  const input = CreateWorkflowBody.parse(request.body);
  const result = await createWorkflowFromInput(
    getAuthenticatedUserId(request),
    input,
    false,
  );
  response.status(201).json(result);
});

router.post("/workflows/demo", async (request, response) => {
  const result = await createWorkflowFromInput(
    getAuthenticatedUserId(request),
    {
      title: "Customer payment issue",
      description:
        "A customer was charged for an order, but the order was not created. Verify the payment, recover or recreate the order if it is safe to do so, and prepare a refund recommendation if recovery is not possible.",
      department: "Finance and Support",
    },
    true,
  );
  response.status(201).json(result);
});

router.get("/workflows/:workflowId", async (request, response) => {
  const workflow = await ownedWorkflow(
    request.params.workflowId,
    getAuthenticatedUserId(request),
  );
  response.json(await workflowDetail(workflow, getAuthenticatedUserId(request)));
});

router.put("/workflows/:workflowId", async (request, response) => {
  const workflow = await ownedWorkflow(
    request.params.workflowId,
    getAuthenticatedUserId(request),
  );
  const update = UpdateWorkflowBody.parse(request.body);
  if (update.title !== undefined) workflow.title = update.title.trim();
  if (update.description !== undefined) workflow.description = update.description.trim();
  if (update.department !== undefined) workflow.department = update.department.trim();
  if (update.deadline !== undefined) {
    workflow.deadline = update.deadline ? new Date(update.deadline) : null;
  }
  await workflow.save();
  const tasks = await TaskModel.find({ workflowId: workflow._id });
  response.json(toWorkflow(workflow, tasks));
});

router.delete("/workflows/:workflowId", async (request, response) => {
  const workflow = await ownedWorkflow(
    request.params.workflowId,
    getAuthenticatedUserId(request),
  );
  await Promise.all([
    TaskModel.deleteMany({ workflowId: workflow._id }),
    AgentLogModel.deleteMany({ workflowId: workflow._id }),
    ApprovalModel.deleteMany({ workflowId: workflow._id }),
    NotificationModel.deleteMany({ workflowId: workflow._id }),
  ]);
  await workflow.deleteOne();
  response.status(204).end();
});

router.post("/workflows/:workflowId/start", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  if (["completed", "failed"].includes(workflow.status)) {
    throw new HttpError(409, "A completed or failed workflow cannot be started.");
  }
  const tasks = await TaskModel.find({ workflowId: workflow._id }).sort({
    createdAt: 1,
  });
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Started workflow",
    "Execution started. The Monitoring Agent will track task progress.",
  );
  await startNextReadyTask(workflow, tasks);
  response.json(await workflowDetail(workflow, ownerId));
});

router.post("/workflows/:workflowId/pause", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  workflow.status = "paused";
  workflow.currentStep = "Paused by user";
  await workflow.save();
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Paused workflow",
    "Execution is paused at the user's request.",
  );
  response.json(await workflowDetail(workflow, ownerId));
});

router.post("/workflows/:workflowId/execute", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  if (workflow.status === "paused") {
    throw new HttpError(409, "Resume the workflow before executing another step.");
  }
  const tasks = await TaskModel.find({ workflowId: workflow._id }).sort({
    createdAt: 1,
  });
  let activeTask = tasks.find((task) => task.status === "In Progress");
  if (!activeTask) {
    await startNextReadyTask(workflow, tasks);
    activeTask = await TaskModel.findOne({
      workflowId: workflow._id,
      status: "In Progress",
    });
  }

  if (!activeTask) {
    response.json(await workflowDetail(workflow, ownerId));
    return;
  }
  if (activeTask.requiresApproval) {
    const pending = await ApprovalModel.findOne({
      taskId: activeTask._id,
      status: "pending",
    });
    if (pending) {
      workflow.status = "awaiting_approval";
      workflow.currentStep = "Waiting for human approval";
      await workflow.save();
      response.json(await workflowDetail(workflow, ownerId));
      return;
    }
  }

  activeTask.status = "Completed";
  await activeTask.save();
  await writeLog(
    workflow._id,
    activeTask.assignedAgent,
    "Completed task",
    `Completed “${activeTask.title}”.`,
  );
  await writeLog(
    workflow._id,
    "Monitoring Agent",
    "Verified task result",
    `Confirmed completion of “${activeTask.title}” and checked the next dependency.`,
  );
  const refreshedTasks = await TaskModel.find({ workflowId: workflow._id }).sort({
    createdAt: 1,
  });
  await startNextReadyTask(workflow, refreshedTasks);
  response.json(await workflowDetail(workflow, ownerId));
});

router.post("/workflows/:workflowId/simulate-failure", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  const task =
    (await TaskModel.findOne({
      workflowId: workflow._id,
      status: "In Progress",
    })) ??
    (await TaskModel.findOne({ workflowId: workflow._id, status: "Pending" }).sort({
      createdAt: 1,
    }));
  if (!task) throw new HttpError(409, "There is no active task to fail.");

  const reason = `${task.assignedAgent} is unavailable for this simulation.`;
  task.status = "Failed";
  await task.save();
  await runReplan(workflow, ownerId, task, reason);
  response.json(await workflowDetail(workflow, ownerId));
});

router.post("/workflows/:workflowId/replan", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  const task =
    (await TaskModel.findOne({ workflowId: workflow._id, status: "Failed" }).sort({
      updatedAt: -1,
    })) ??
    (await TaskModel.findOne({ workflowId: workflow._id, status: "Blocked" }));
  if (!task) {
    throw new HttpError(409, "Replanning is available after a task is blocked or failed.");
  }
  await runReplan(workflow, ownerId, task, "The user requested a fresh plan.");
  response.json(await workflowDetail(workflow, ownerId));
});

router.post("/workflows/:workflowId/complete", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflow = await ownedWorkflow(request.params.workflowId, ownerId);
  const [tasks, pendingApproval] = await Promise.all([
    TaskModel.find({ workflowId: workflow._id }),
    ApprovalModel.findOne({ workflowId: workflow._id, status: "pending" }),
  ]);
  if (pendingApproval || tasks.some((task) => !taskIsResolved(task, tasks))) {
    throw new HttpError(
      409,
      "Resolve open tasks and approvals before completing this workflow.",
    );
  }
  workflow.status = "completed";
  workflow.currentStep = "Resolved";
  await workflow.save();
  await writeLog(
    workflow._id,
    "Orchestrator",
    "Completed workflow",
    "All tasks and approvals are resolved.",
  );
  response.json(await workflowDetail(workflow, ownerId));
});

router.get("/workflows/:workflowId/agents", async (request, response) => {
  const workflow = await ownedWorkflow(
    request.params.workflowId,
    getAuthenticatedUserId(request),
  );
  const activity = await AgentLogModel.find({ workflowId: workflow._id })
    .sort({ timestamp: -1 })
    .limit(100);
  response.json(activity.map(toLog));
});

router.get("/tasks", async (request, response) => {
  const ids = await ownedWorkflowIds(getAuthenticatedUserId(request));
  if (ids.length === 0) {
    response.json([]);
    return;
  }
  const tasks = await TaskModel.find({ workflowId: { $in: ids } }).sort({
    updatedAt: -1,
  });
  response.json(tasks.map(toTask));
});

router.get("/tasks/:taskId", async (request, response) => {
  const task = await ownedTask(
    request.params.taskId,
    getAuthenticatedUserId(request),
  );
  response.json(toTask(task));
});

router.put("/tasks/:taskId", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const task = await ownedTask(request.params.taskId, ownerId);
  const update = UpdateTaskBody.parse(request.body);
  if (update.assignedAgent !== undefined) {
    task.assignedAgent = update.assignedAgent.trim();
  }
  if (update.status !== undefined) {
    if (update.status === "Completed" && task.requiresApproval) {
      const pending = await ApprovalModel.findOne({
        taskId: task._id,
        status: "pending",
      });
      if (pending) {
        throw new HttpError(409, "This task needs human approval before completion.");
      }
    }
    if (update.status === "In Progress" && task.dependencies.length > 0) {
      const completed = await TaskModel.find({
        workflowId: task.workflowId,
        title: { $in: task.dependencies },
        status: "Completed",
      }).select("title");
      if (completed.length !== task.dependencies.length) {
        throw new HttpError(409, "Complete this task's dependencies first.");
      }
    }
    task.status = update.status;
  }
  await task.save();
  const workflow = await WorkflowModel.findById(task.workflowId);
  if (workflow) {
    await writeLog(
      workflow._id,
      "Execution Agent",
      "Updated task",
      `“${task.title}” is now ${task.status}.`,
    );
    if (task.status === "Completed") {
      const tasks = await TaskModel.find({ workflowId: workflow._id }).sort({
        createdAt: 1,
      });
      await startNextReadyTask(workflow, tasks);
    } else if (task.status === "Failed") {
      await runReplan(workflow, ownerId, task, "A user marked the task as failed.");
    }
  }
  response.json(toTask(task));
});

router.get("/approvals", async (request, response) => {
  const ids = await ownedWorkflowIds(getAuthenticatedUserId(request));
  if (ids.length === 0) {
    response.json([]);
    return;
  }
  const approvals = await ApprovalModel.find({ workflowId: { $in: ids } }).sort({
    createdAt: -1,
  });
  response.json(approvals.map(toApproval));
});

async function updateApproval(
  request: Request,
  decision: "approved" | "rejected",
) {
  const ownerId = getAuthenticatedUserId(request);
  const approvalId = validId(String(request.params.approvalId), "Approval");
  const approval = await ApprovalModel.findById(approvalId);
  if (!approval) throw new HttpError(404, "Approval request not found.");
  const workflow = await ownedWorkflow(approval.workflowId.toString(), ownerId);
  if (approval.status !== "pending") {
    throw new HttpError(409, "This approval has already been decided.");
  }
  const parsed = approvalDecisionSchema.parse(request.body ?? {});
  approval.status = decision;
  approval.decidedBy = ownerId;
  approval.decisionReason = parsed.reason?.trim() || null;
  await approval.save();
  await writeLog(
    workflow._id,
    "Manager Agent",
    decision === "approved" ? "Approval granted" : "Approval rejected",
    decision === "approved"
      ? `Approved “${approval.action}”.`
      : `Rejected “${approval.action}”. ${parsed.reason?.trim() ?? ""}`,
  );

  if (approval.taskId) {
    const task = await TaskModel.findById(approval.taskId);
    if (task) {
      if (decision === "approved") {
        task.status = "Completed";
        await task.save();
        await writeLog(
          workflow._id,
          "Execution Agent",
          "Executed approved action",
          `Completed “${task.title}” after human approval.`,
        );
        const tasks = await TaskModel.find({ workflowId: workflow._id }).sort({
          createdAt: 1,
        });
        await startNextReadyTask(workflow, tasks);
      } else {
        task.status = "Blocked";
        await task.save();
        await runReplan(
          workflow,
          ownerId,
          task,
          `A human rejected the proposed action. ${parsed.reason?.trim() ?? "No reason was provided."}`,
        );
      }
    }
  }

  const pending = await ApprovalModel.findOne({
    workflowId: workflow._id,
    status: "pending",
  });
  if (!pending && workflow.status === "awaiting_approval") {
    const tasks = await TaskModel.find({ workflowId: workflow._id }).sort({
      createdAt: 1,
    });
    await startNextReadyTask(workflow, tasks);
  }
  return toApproval(approval);
}

router.post("/approvals/:approvalId/approve", async (request, response) => {
  response.json(await updateApproval(request, "approved"));
});

router.post("/approvals/:approvalId/reject", async (request, response) => {
  response.json(await updateApproval(request, "rejected"));
});

router.get("/analytics/dashboard", async (request, response) => {
  const ownerId = getAuthenticatedUserId(request);
  const workflows = await WorkflowModel.find({ ownerId: validId(ownerId, "User") })
    .sort({ updatedAt: -1 })
    .limit(200);
  const ids = workflows.map((workflow) => workflow._id);
  const [tasks, activity, completedWorkflows] = await Promise.all([
    ids.length
      ? TaskModel.find({ workflowId: { $in: ids } })
      : Promise.resolve([] as TaskDocument[]),
    ids.length
      ? AgentLogModel.find({ workflowId: { $in: ids } })
          .sort({ timestamp: -1 })
          .limit(8)
      : Promise.resolve([] as AgentLogDocument[]),
    Promise.resolve(
      workflows.filter((workflow) => workflow.status === "completed"),
    ),
  ]);
  const durations = completedWorkflows.map(
    (workflow) =>
      (workflow.updatedAt.getTime() - workflow.createdAt.getTime()) / 3600000,
  );
  const averageResolutionHours =
    durations.length === 0
      ? 0
      : Math.round(
          (durations.reduce((sum, duration) => sum + duration, 0) /
            durations.length) *
            10,
        ) / 10;
  response.json({
    totalWorkflows: workflows.length,
    activeWorkflows: workflows.filter(
      (workflow) => !["completed", "failed"].includes(workflow.status),
    ).length,
    completedWorkflows: completedWorkflows.length,
    pendingTasks: tasks.filter((task) =>
      ["Pending", "In Progress", "Blocked"].includes(task.status),
    ).length,
    highPriorityWorkflows: workflows.filter((workflow) =>
      ["High", "Critical"].includes(workflow.priority),
    ).length,
    failedTasks: tasks.filter((task) => task.status === "Failed").length,
    replannedWorkflows: workflows.filter((workflow) => workflow.replannedAt).length,
    averageResolutionHours,
    activity: activity.map(toLog),
  });
});

router.get("/activity", async (request, response) => {
  const ids = await ownedWorkflowIds(getAuthenticatedUserId(request));
  if (ids.length === 0) {
    response.json([]);
    return;
  }
  const activity = await AgentLogModel.find({ workflowId: { $in: ids } })
    .sort({ timestamp: -1 })
    .limit(60);
  response.json(activity.map(toLog));
});

export default router;
