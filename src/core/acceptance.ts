/**
 * Sépare la description d'un ticket de ses critères d'acceptation.
 *
 * Azure DevOps a un champ dédié. GitHub n'en a pas : la convention est une
 * section `## Critères d'acceptation` dans le corps de l'issue. Quand elle est
 * absente, les critères restent vides et seront extraits à la planification.
 */

/** Titres reconnus comme ouvrant la section des critères, en français et en anglais. */
const HEADINGS = [
  "critères d'acceptation",
  "critères d'acceptance",
  'criteres d\'acceptation',
  'acceptance criteria',
  'critères',
  'definition of done'
];

export interface SplitBody {
  description: string;
  acceptanceCriteria: string;
}

export function extractAcceptanceCriteria(body: string): SplitBody {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => isAcceptanceHeading(line));

  if (start === -1) {
    return { description: body.trim(), acceptanceCriteria: '' };
  }

  const startLevel = headingLevel(lines[start] ?? '');
  // La section court jusqu'au prochain titre de niveau égal ou supérieur.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const level = headingLevel(lines[i] ?? '');
    if (level > 0 && level <= startLevel) {
      end = i;
      break;
    }
  }

  const description = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
  const acceptanceCriteria = lines.slice(start + 1, end).join('\n').trim();
  return { description, acceptanceCriteria };
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line.trim());
  return match?.[1]?.length ?? 0;
}

function isAcceptanceHeading(line: string): boolean {
  if (headingLevel(line) === 0) {
    return false;
  }
  const text = line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/[:*_`]/g, '')
    .trim()
    .toLowerCase();
  return HEADINGS.includes(text);
}
