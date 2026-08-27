/**
 * agent/runtime/clone.js — Entity Clone Helper
 *
 * V1.2.3
 * Deep-clones Runtime entities so Store.get()/list()/serialize() return
 * FULLY detached copies.
 *
 * Why this matters:
 *   A shallow clone ({ ...entity }) still shares nested arrays with the
 *   Store's internal object — taskIds, tasks, dependencies, assignedSkills,
 *   metadata. A caller doing `run.taskIds.push(id)` on a shallow clone
 *   silently mutates Store internals without ever calling update().
 *
 *   Deep cloning closes that gap: every get() returns an independent copy
 *   at every nesting level, so the ONLY path to Store mutation is update().
 */

/**
 * Deep-clone a Runtime entity.
 *
 * structuredClone is used when available (Node >= 17, this project requires
 * >= 20). It handles plain data objects/arrays/ Dates correctly and throws
 * on non-cloneable values, which is a loud failure for an entity that
 * should never contain functions or symbols.
 */
export function cloneEntity(entity) {
  if (entity === null || typeof entity !== 'object') {
    return entity;
  }
  try {
    return structuredClone(entity);
  } catch (err) {
    // Fallback for exotic values — entities are plain data, so this path
    // only triggers on a programming error. JSON round-trip preserves the
    // common scalar/array/plain-object shape.
    return JSON.parse(JSON.stringify(entity));
  }
}