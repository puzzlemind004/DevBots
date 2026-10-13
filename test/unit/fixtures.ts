import type { StoryPlan, Understanding } from '../../src/core/plan.js';

export function samplePlan(overrides: Partial<StoryPlan> = {}): StoryPlan {
  return {
    understanding: {
      restatement: "Valider le format de l'email à l'inscription.",
      assumptions: ['La validation se fait côté client et côté serveur.'],
      decisions: ['Q1 : message sous le champ.']
    },
    coverage: [
      { criterion_id: 'C1', criterion: 'Un email invalide est refusé', step_ids: [1] },
      { criterion_id: 'C2', criterion: 'Un message explique pourquoi', step_ids: [2] }
    ],
    steps: [
      { id: 1, title: 'Validateur', approach: 'Ajouter un validateur.', files: ['src/app/email.validator.ts'] },
      { id: 2, title: 'Message', approach: "Afficher l'erreur.", files: ['src/app/signup.component.html'] }
    ],
    tests: { unit: ['email.validator.spec.ts'], e2e: [] },
    dependencies: [{ source_id: '40', verdict: 'confirmed', reason: 'Même formulaire.' }],
    risks: ['Formulaire partagé avec la page profil.'],
    execution: { model: 'sonnet', complexity: 'low', rationale: 'Changement local.' },
    ...overrides
  };
}

export function sampleUnderstanding(overrides: Partial<Understanding> = {}): Understanding {
  return {
    restatement: "Refuser les emails mal formés à l'inscription.",
    assumptions: ['Pas de vérification MX.'],
    questions: [
      { id: 'Q1', question: 'Où afficher le message ?', blocking: true, choices: ['Sous le champ', 'En toast'] },
      { id: 'Q2', question: 'Bloquer le bouton ?', blocking: false, choices: ['Oui', 'Non'] }
    ],
    ...overrides
  };
}

export const SAMPLE_CARD = `---
source: "github"
source_id: "42"
source_rev: "2026-10-01T10:00:00Z"
parent: "30"
imported_at: "2026-10-13T08:00:00.000Z"
title: "Valider l'email à l'inscription"
state: "open"
web_url: "https://github.com/acme/web/issues/42"
dependencies:
  - "40"
---

# Valider l'email à l'inscription

## Description

Le formulaire accepte n'importe quoi.

## Critères d'acceptation

- Un email invalide est refusé
- Un message explique pourquoi

## Dépendances déclarées

- Bloquée par : 40 — Créer le service

---

[Ouvrir dans la source](https://github.com/acme/web/issues/42)
`;
