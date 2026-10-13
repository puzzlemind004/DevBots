import { describe, expect, it } from 'vitest';
import { parseDependencies, parseIssueNumber } from '../../src/sources/github.js';
import { levelForType, parseWorkItemId } from '../../src/sources/azureDevOps.js';
import { parseGitHubRemote, parseRepoSlug } from '../../src/core/repoSlug.js';
import { compareVersions, parseVersion } from '../../src/core/claudeCli.js';

describe('parseIssueNumber', () => {
  it.each([
    ['42', 42],
    ['#42', 42],
    ['https://github.com/acme/web/issues/42', 42]
  ])('lit %s', (raw, expected) => {
    expect(parseIssueNumber(raw)).toBe(expected);
  });

  it('refuse une entrée qui ne porte pas de numéro', () => {
    expect(() => parseIssueNumber('la story du panier')).toThrow(/non reconnu/);
  });
});

describe('parseDependencies', () => {
  it('lit les conventions anglaise et française', () => {
    const deps = parseDependencies('Blocked by #12\nBloque #15');
    expect(deps).toEqual([
      { kind: 'blockedBy', sourceId: '12' },
      { kind: 'blocks', sourceId: '15' }
    ]);
  });

  it('ne retient pas deux fois la même dépendance', () => {
    const deps = parseDependencies('blocked by #12 et encore Blocked By #12');
    expect(deps).toHaveLength(1);
  });

  it('ne trouve rien dans un corps sans mot-clé', () => {
    expect(parseDependencies('Voir #12 pour le contexte')).toEqual([]);
  });
});

describe('parseWorkItemId', () => {
  it.each([
    ['1234', 1234],
    ['#1234', 1234],
    ['https://dev.azure.com/org/proj/_workitems/edit/1234', 1234]
  ])('lit %s', (raw, expected) => {
    expect(parseWorkItemId(raw)).toBe(expected);
  });
});

describe('levelForType', () => {
  it('range les types ADO sur les trois niveaux', () => {
    expect(levelForType('Epic')).toBe('epic');
    expect(levelForType('Feature')).toBe('feature');
    expect(levelForType('User Story')).toBe('story');
    expect(levelForType('Product Backlog Item')).toBe('story');
  });
});

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/acme/web.git', 'acme/web'],
    ['https://github.com/acme/web', 'acme/web'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['ssh://git@github.com/acme/web.git', 'acme/web']
  ])('déduit %s', (url, expected) => {
    expect(parseGitHubRemote(url)).toBe(expected);
  });

  it('ignore un remote qui ne vient pas de GitHub', () => {
    expect(parseGitHubRemote('https://dev.azure.com/org/_git/web')).toBeUndefined();
  });
});

describe('parseRepoSlug', () => {
  it('sépare owner et repo', () => {
    expect(parseRepoSlug('acme/web')).toEqual({ owner: 'acme', repo: 'web' });
  });

  it('refuse une forme incomplète', () => {
    expect(() => parseRepoSlug('acme')).toThrow(/owner\/repo/);
  });
});

describe('version du CLI Claude', () => {
  it('lit la version dans la sortie du CLI', () => {
    expect(parseVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
  });

  it('compare les versions par segment, pas par chaîne', () => {
    expect(compareVersions('2.1.296', '2.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    // 2.10 est postérieur à 2.9, ce qu'une comparaison de chaînes raterait.
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
  });
});
