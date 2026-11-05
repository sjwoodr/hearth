import fs from 'node:fs';

/**
 * The system prompt file with `{{name}}` filled in: the name the assistant answers to
 * (`HEARTH_ASSISTANT_NAME`, "hearth" by default). The app stays hearth whatever the name, so the
 * prompt names it separately. Works the same for a replacement prompt (`HEARTH_SYSTEM_PROMPT`).
 */
export function readSystemPrompt(file: string, name: string): string {
  return withName(fs.readFileSync(file, 'utf8').trim(), name);
}

export function withName(prompt: string, name: string): string {
  return prompt.replaceAll('{{name}}', name);
}
