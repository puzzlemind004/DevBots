import { describe, expect, it } from 'vitest';
import { extractAcceptanceCriteria } from '../../src/core/acceptance.js';

describe('extractAcceptanceCriteria', () => {
  it("laisse les critères vides quand l'issue n'a pas la section", () => {
    const result = extractAcceptanceCriteria('Un corps simple.\n\nSans section.');
    expect(result.acceptanceCriteria).toBe('');
    expect(result.description).toBe('Un corps simple.\n\nSans section.');
  });

  it("sépare la section française des critères", () => {
    const body = [
      'Le formulaire doit valider la saisie.',
      '',
      "## Critères d'acceptation",
      '',
      '- Un email invalide affiche une erreur',
      '- Le bouton reste désactivé',
      ''
    ].join('\n');
    const result = extractAcceptanceCriteria(body);
    expect(result.description).toBe('Le formulaire doit valider la saisie.');
    expect(result.acceptanceCriteria).toBe(
      '- Un email invalide affiche une erreur\n- Le bouton reste désactivé'
    );
  });

  it('reconnaît le titre anglais', () => {
    const result = extractAcceptanceCriteria('Body.\n\n## Acceptance Criteria\n\n- Works');
    expect(result.acceptanceCriteria).toBe('- Works');
  });

  it('arrête la section au titre de même niveau et garde la suite en description', () => {
    const body = [
      'Contexte.',
      '',
      "## Critères d'acceptation",
      '',
      '- Premier critère',
      '',
      '## Notes techniques',
      '',
      'Utiliser le service existant.'
    ].join('\n');
    const result = extractAcceptanceCriteria(body);
    expect(result.acceptanceCriteria).toBe('- Premier critère');
    expect(result.description).toContain('## Notes techniques');
    expect(result.description).toContain('Utiliser le service existant.');
    expect(result.description).not.toContain('Premier critère');
  });

  it('ne coupe pas sur un sous-titre plus profond', () => {
    const body = [
      "## Critères d'acceptation",
      '',
      '### Cas nominal',
      '- Ça marche',
      '',
      '## Hors périmètre',
      'Rien.'
    ].join('\n');
    const result = extractAcceptanceCriteria(body);
    expect(result.acceptanceCriteria).toContain('### Cas nominal');
    expect(result.acceptanceCriteria).toContain('- Ça marche');
    expect(result.acceptanceCriteria).not.toContain('Hors périmètre');
  });
});
