import { color } from "../ui.js";

// Plan mode, in three pieces:
//
//   1. The user types /plan. DevPilot sets state.mode = "plan".
//   2. While it is on, tools/index.js refuses every tool that is not
//      read-only, and each user message carries a reminder (prompt.js).
//      The system prompt itself never changes, which keeps prompt caching
//      working (see caching.js).
//   3. The model explores, then calls exit_plan_mode with its plan. The user
//      approves (plan mode ends, edits are allowed) or gives feedback.
export const exitPlanMode = {
  name: "exit_plan_mode",
  description:
    "Use only while plan mode is on. Present your implementation plan to the " +
    "user for approval once you have explored enough to be concrete: which files " +
    "change, how, in what order, and how you will verify it. If the user " +
    "approves, plan mode ends and you can start making changes.",
  parameters: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The plan, as short markdown with numbered steps." },
    },
    required: ["plan"],
  },
  readOnly: true,

  async run({ plan }, ctx) {
    if (ctx.state.mode !== "plan") {
      return "Plan mode is not on, so no approval is needed. Go ahead with the task.";
    }

    const decision = await ctx.approve(
      {
        title: "Approve this plan and start implementing?",
        preview: `${color.bold("Proposed plan")}\n\n${plan.trim()}`,
      },
      ctx.signal
    );
    if (!decision.allowed) {
      return `${decision.message} Plan mode is still on: revise the plan, then call exit_plan_mode again.`;
    }

    ctx.state.mode = "default";
    ctx.session.logEvent("mode", { mode: "default" });
    console.log(color.green("  Plan approved; plan mode is off."));
    return "The user approved the plan. Plan mode is off: implement it now, tracking the steps with todo_write.";
  },
};
