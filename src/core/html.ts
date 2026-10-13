/**
 * Conversion du HTML d'Azure DevOps en markdown.
 *
 * Les champs description et critères d'acceptation d'ADO sont du HTML riche ;
 * les fiches de `.work` sont en markdown.
 */

import TurndownService from 'turndown';

let service: TurndownService | undefined;

function getService(): TurndownService {
  if (!service) {
    service = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '_'
    });
    // ADO met des <div> partout : sans cette règle, chaque ligne devient un bloc collé.
    service.addRule('divAsParagraph', {
      filter: ['div'],
      replacement: (content) => (content.trim() ? `\n\n${content.trim()}\n\n` : '')
    });
  }
  return service;
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) {
    return '';
  }
  // Un champ ADO peut contenir du texte brut ; turndown le laisse alors intact.
  return getService()
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
