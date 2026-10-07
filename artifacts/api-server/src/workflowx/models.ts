import {
  HydratedDocument,
  InferSchemaType,
  Schema,
  Types,
  model,
  models,
} from "mongoose";

export const PRIORITIES = ["Low", "Medium", "High", "Critical"] as const;
export const TASK_STATUSES = [
  "Pending",
  "In Progress",
  "Blocked",
  "Completed",
  "Failed",
] as const;
export const WORKFLOW_STATUSES = [
  "draft",
  "analyzing",
  "planning",
  "ready",
  "executing",
  "monitoring",
  "blocked",
  "replanning",
  "awaiting_approval",
  "completed",
  "failed",
  "paused",
] as const;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["user", "manager"], default: "user" },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });

const workflowSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXUser",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, maxlength: 8000 },
    department: { type: String, default: "Operations" },
    category: { type: String, required: true, default: "Business Operations" },
    priority: { type: String, enum: PRIORITIES, default: "Medium" },
    impact: { type: String, enum: PRIORITIES, default: "Medium" },
    status: { type: String, enum: WORKFLOW_STATUSES, default: "draft" },
    currentStep: { type: String, default: "Awaiting analysis" },
    aiAnalysis: { type: Schema.Types.Mixed, default: null },
    requiresApproval: { type: Boolean, default: false },
    deadline: { type: Date, default: null },
    replannedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
workflowSchema.index({ ownerId: 1, updatedAt: -1 });

const taskSchema = new Schema(
  {
    workflowId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXWorkflow",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    description: { type: String, required: true, maxlength: 2000 },
    assignedAgent: { type: String, required: true },
    priority: { type: String, enum: PRIORITIES, default: "Medium" },
    status: { type: String, enum: TASK_STATUSES, default: "Pending" },
    dependencies: { type: [String], default: [] },
    requiresApproval: { type: Boolean, default: false },
    deadline: { type: Date, default: null },
    estimatedMinutes: { type: Number, default: 30, min: 1, max: 10080 },
    replannedFrom: { type: Schema.Types.ObjectId, ref: "WorkflowXTask", default: null },
  },
  { timestamps: true },
);
taskSchema.index({ workflowId: 1, createdAt: 1 });

const agentLogSchema = new Schema({
  workflowId: {
    type: Schema.Types.ObjectId,
    ref: "WorkflowXWorkflow",
    required: true,
    index: true,
  },
  agentName: { type: String, required: true },
  action: { type: String, required: true },
  status: { type: String, required: true, default: "completed" },
  summary: { type: String, required: true, maxlength: 1200 },
  timestamp: { type: Date, default: Date.now, index: true },
});
agentLogSchema.index({ workflowId: 1, timestamp: -1 });

const approvalSchema = new Schema(
  {
    workflowId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXWorkflow",
      required: true,
      index: true,
    },
    taskId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXTask",
      default: null,
    },
    action: { type: String, required: true, maxlength: 180 },
    reason: { type: String, required: true, maxlength: 1200 },
    recommendation: { type: String, required: true, maxlength: 1200 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    decidedBy: { type: String, default: null },
    decisionReason: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true },
);
approvalSchema.index({ workflowId: 1, status: 1 });

const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXUser",
      required: true,
      index: true,
    },
    workflowId: {
      type: Schema.Types.ObjectId,
      ref: "WorkflowXWorkflow",
      default: null,
    },
    message: { type: String, required: true, maxlength: 1000 },
    type: { type: String, enum: ["info", "warning", "approval"], default: "info" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const UserModel =
  models.WorkflowXUser ?? model("WorkflowXUser", userSchema);
export const WorkflowModel =
  models.WorkflowXWorkflow ?? model("WorkflowXWorkflow", workflowSchema);
export const TaskModel =
  models.WorkflowXTask ?? model("WorkflowXTask", taskSchema);
export const AgentLogModel =
  models.WorkflowXAgentLog ?? model("WorkflowXAgentLog", agentLogSchema);
export const ApprovalModel =
  models.WorkflowXApproval ?? model("WorkflowXApproval", approvalSchema);
export const NotificationModel =
  models.WorkflowXNotification ??
  model("WorkflowXNotification", notificationSchema);

export type UserData = InferSchemaType<typeof userSchema>;
export type WorkflowData = InferSchemaType<typeof workflowSchema>;
export type TaskData = InferSchemaType<typeof taskSchema>;
export type AgentLogData = InferSchemaType<typeof agentLogSchema>;
export type ApprovalData = InferSchemaType<typeof approvalSchema>;
export type UserDocument = HydratedDocument<UserData>;
export type WorkflowDocument = HydratedDocument<WorkflowData>;
export type TaskDocument = HydratedDocument<TaskData>;
export type AgentLogDocument = HydratedDocument<AgentLogData>;
export type ApprovalDocument = HydratedDocument<ApprovalData>;
export type MongoId = Types.ObjectId;
