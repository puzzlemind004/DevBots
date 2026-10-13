/**
 * Fabrique les fiches markdown de `.work/new` à partir des tickets normalisés.
 *
 * Le format des fiches ne change pas : frontmatter, titre, description,
 * critères d'acceptation, dépendances. Les skills existants continuent de les lire.
 */

import type { StoryFrontmatter, Ticket } from './model.js';
import type { SourceKind } from './model.js';

/** Nom de fichier d'une story : `<id>-<slug>.md`. */
export function storyFileName(ticket: Ticket): string {
  return `${ticket.sourceId}-${slugify(ticket.title)}.md`;
}

/**
 * Réduit un titre à un slug court utilisable comme nom de fichier et de branche.
 *
 * Les accents sont décomposés puis retirés, tout le reste devient des tirets.
 */
export function slugify(title: string, maxLength = 50): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) {
    return slug || 'story';
  }
  // Coupe sur un tiret pour ne pas laisser un mot tronqué.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return lastDash > 20 ? cut.slice(0, lastDash) : cut;
}

export function buildFrontmatter(
  ticket: Ticket,
  source: SourceKind,
  importedAt: Date
): StoryFrontmatter {
  const fm: StoryFrontmatter = {
    source,
    source_id: ticket.sourceId,
    source_rev: ticket.revision,
    parent: ticket.parentId ?? null,
    imported_at: importedAt.toISOString(),
    title: ticket.title,
    state: ticket.state,
    web_url: ticket.webUrl
  };
  const blockedBy = ticket.dependencies
    .filter((d) => d.kind === 'blockedBy')
    .map((d) => d.sourceId);
  if (blockedBy.length > 0) {
    fm.dependencies = blockedBy;
  }
  if (ticket.storyPoints !== undefined) {
    fm.story_points = ticket.storyPoints;
  }
  if (ticket.priority !== undefined) {
    fm.priority = ticket.priority;
  }
  return fm;
}

/** Rend le frontmatter en YAML. Les valeurs sont toujours citées pour éviter les surprises de typage. */
export function renderFrontmatter(fm: StoryFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function yamlScalar(value: string | number | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  // Les titres contiennent des deux-points et des apostrophes : on cite en double
  // et on échappe les guillemets et les antislashs.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Fabrique le contenu complet d'une fiche de story. */
export function renderStoryCard(
  ticket: Ticket,
  source: SourceKind,
  importedAt: Date
): string {
  const parts: string[] = [
    renderFrontmatter(buildFrontmatter(ticket, source, importedAt)),
    '',
    `# ${ticket.title}`,
    ''
  ];

  parts.push('## Description', '');
  parts.push(ticket.description.trim() || '_Aucune description dans la source._', '');

  parts.push("## Critères d'acceptation", '');
  parts.push(
    ticket.acceptanceCriteria.trim() ||
      "_Aucun critère dans la source. À extraire à la planification._",
    ''
  );

  if (ticket.dependencies.length > 0) {
    parts.push('## Dépendances déclarées', '');
    for (const dep of ticket.dependencies) {
      const verb = dep.kind === 'blockedBy' ? 'Bloquée par' : 'Bloque';
      const label = dep.title ? `${dep.sourceId} — ${dep.title}` : dep.sourceId;
      parts.push(`- ${verb} : ${label}`);
    }
    parts.push(
      '',
      '_Déclarées dans la source, à confirmer d\'après les fichiers impactés à la planification._',
      ''
    );
  }

  if (ticket.attachments.length > 0) {
    parts.push('## Pièces jointes', '');
    for (const att of ticket.attachments) {
      parts.push(`- [${att.name}](${att.url})`);
    }
    parts.push('');
  }

  parts.push('---', '', `[Ouvrir dans la source](${ticket.webUrl})`, '');
  return parts.join('\n');
}
