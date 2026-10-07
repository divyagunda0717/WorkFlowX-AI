import { Router, type IRouter } from "express";
import healthRouter from "./health";
import workflowxRouter from "../workflowx/router";

const router: IRouter = Router();

router.use(healthRouter);
router.use(workflowxRouter);

export default router;
