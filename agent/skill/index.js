/**
 * agent/skill/index.js — Skill Domain Barrel
 *
 * V0.8.2: Re-exports all Skill Domain modules.
 * agent/skill.js remains as the public entry point for backward compatibility.
 */

export * from './model.js';
export * from './lifecycle.js';
export * from './registry.js';
export * from './verification.js';