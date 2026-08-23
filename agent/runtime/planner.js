/**
 * agent/runtime/planner.js — Planner Interface
 *
 * V0.9.2
 * - Planner: abstract interface for goal → Plan translation
 * - MockPlanner: deterministic implementation for testing
 * - RuleBasedPlanner: simple rule-based implementation
 *
 * Design:
 *   Planner is NOT part of Runtime.
 *   Planner produces Plan Object → Runtime executes it.
 *   Runtime does NOT depend on Planner.
 */

import { createPlan } from './plan.js';
import { createTask } from './task.js';

/**
 * V0.9.2: Planner Interface.
 *
 * Implementations translate a user goal into a Plan Object.
 * The Plan is then handed to Runtime for execution.
 *
 * This is an interface contract, not a concrete implementation.
 * V0.9.2 provides MockPlanner and RuleBasedPlanner.
 * LLM Planner is a future implementation of this interface.
 */
class Planner {
  constructor() {
    this.name = 'planner';
  }

  /**
   * Create a plan from a goal.
   * @param {string} goal - User goal
   * @param {object} context - Execution context { runId, workspace, availableSkills, availableTools }
   * @returns {object} Plan Object (status: DRAFT)
   */
  createPlan(goal, context) {
    throw new Error('Planner.createPlan() must be implemented by subclass');
  }

  /**
   * Revise an existing plan based on new information.
   * @param {object} plan - Current Plan
   * @param {object} revision - What changed
   * @returns {object} Revised Plan
   */
  revisePlan(plan, revision) {
    throw new Error('Planner.revisePlan() must be implemented by subclass');
  }
}

/**
 * V0.9.2: MockPlanner — deterministic planner for testing.
 * Returns a fixed plan regardless of input.
 */
class MockPlanner extends Planner {
  constructor(fixedPlan) {
    super();
    this.name = 'mock-planner';
    this.fixedPlan = fixedPlan;
  }

  createPlan(goal, context) {
    return {
      ...this.fixedPlan,
      goal: goal || this.fixedPlan.goal,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  revisePlan(plan, revision) {
    return {
      ...plan,
      ...revision,
      updatedAt: Date.now(),
      revision: (plan.revision || 1) + 1,
      previousRevision: plan.revision || 1,
    };
  }
}

/**
 * V0.9.2: RuleBasedPlanner — simple rule-based plan creation.
 * Useful for deterministic workflows without LLM.
 */
class RuleBasedPlanner extends Planner {
  constructor(rules = []) {
    super();
    this.name = 'rule-based-planner';
    this.rules = rules;
  }

  createPlan(goal, context) {
    for (const rule of this.rules) {
      if (rule.match(goal)) {
        const tasks = rule.tasks.map(t => ({
          ...t,
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
          status: 'pending',
        }));
        return createPlan(context.runId || 'run-1', goal, {
          tasks,
          description: rule.description,
        });
      }
    }

    // Default: single-task plan
    const task = createTask(context.runId || 'run-1', goal);
    return createPlan(context.runId || 'run-1', goal, {
      tasks: [task],
    });
  }

  revisePlan(plan, revision) {
    return {
      ...plan,
      ...revision,
      updatedAt: Date.now(),
      revision: (plan.revision || 1) + 1,
      previousRevision: plan.revision || 1,
    };
  }
}

/**
 * V0.9.2: Create a simple planner from a goal → tasks mapping.
 */
function createSimplePlanner(goalToTasks) {
  const rules = Object.entries(goalToTasks).map(([goal, tasks]) => ({
    match: (g) => g === goal,
    description: `Rule for: ${goal}`,
    tasks,
  }));
  return new RuleBasedPlanner(rules);
}

export {
  Planner,
  MockPlanner,
  RuleBasedPlanner,
  createSimplePlanner,
};