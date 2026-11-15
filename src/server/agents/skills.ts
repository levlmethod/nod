import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillLibrary } from '../../ports/agent.ts';
import type { AgentConfig, AgentRegistry } from './registry.ts';

export type AgentSkillSources = { root?: string; library?: SkillLibrary };

export function agentSkillsRoot() {
  return (
    process.env.NOD_AGENT_SKILLS_ROOT ||
    fileURLToPath(new URL('../../../agent-skills/', import.meta.url))
  );
}

function body(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function forkSkill(root: string, name: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
  let path;
  try {
    path = realpathSync(join(root, name, 'SKILL.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!path.startsWith(realpathSync(root) + sep) || !statSync(path).isFile())
    throw new Error(`agent-skills/${name}/SKILL.md must be a file inside agent-skills/.`);
  return readFileSync(path, 'utf8');
}

export function loadAgentSkills(sources: AgentSkillSources) {
  const root = sources.root ?? agentSkillsRoot();
  const library = sources.library;
  const content = (name: string) =>
    forkSkill(root, name) ??
    (library &&
    (library.catalog.some((skill) => skill.name === name) || library.core?.includes(name))
      ? library.read(name).content
      : undefined);
  return {
    problem(name: string) {
      try {
        return content(name) === undefined
          ? `${name} is not a skill in agent-skills/ or Nod's skills`
          : undefined;
      } catch (error) {
        return `${name} could not be read: ${(error as Error).message}`;
      }
    },
    read(name: string) {
      const text = content(name);
      if (text === undefined)
        throw new Error(`The skill ${name} is not in agent-skills/ or Nod's skills.`);
      return body(text);
    },
  };
}

export type AgentSkills = ReturnType<typeof loadAgentSkills>;

export function requiredSkills(config: AgentConfig, cardType?: string) {
  return [
    ...new Set([...(config.skills ?? []), ...((cardType && config.cardSkills?.[cardType]) || [])]),
  ];
}

export function rejectMissingSkills(registry: AgentRegistry, skills: AgentSkills) {
  for (const config of [...registry.agents.values()]) {
    const names = new Set([
      ...(config.skills ?? []),
      ...Object.values(config.cardSkills ?? {}).flat(),
    ]);
    const problems = [...names].flatMap((name) => skills.problem(name) ?? []);
    if (!problems.length) continue;
    registry.agents.delete(config.name);
    registry.problems.push({
      path: `${config.team}/${config.name}.md`,
      reason: `skills: ${problems.join('; ')}.`,
    });
  }
}

export function skillInstructions(skills: AgentSkills, names: readonly string[]) {
  return `Follow these required skills in full on every step of this work. They are loaded here, so you don't need to read them.\n\n${names.map((name) => `## Skill: ${name}\n\n${skills.read(name)}`).join('\n\n')}`;
}
