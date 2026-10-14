# Planification

L'atelier fait passer une story de `new/` à `ready/` en deux temps,
compréhension puis plan, et se termine toujours par ta validation explicite.

On l'ouvre par l'ampoule d'une story de New dans le panneau, ou par la commande
« DevBots : planifier la story ». Chaque story a son onglet.

## Déroulé

1. **Compréhension.** Claude lit la fiche et explore le code (en lecture seule :
   `Read`, `Grep`, `Glob`, plus `Skill`), puis renvoie sa reformulation, ses hypothèses et ses
   questions. Chaque question propose des réponses et un champ libre ; les
   questions bloquantes sont marquées.
2. **Réponses.** Cocher une réponse l'enregistre sans rien envoyer.
   « Envoyer mes réponses » les transmet à Claude, qui met à jour sa
   compréhension et peut poser d'autres questions. « Rédiger le plan »
   n'apparaît qu'une fois tes réponses envoyées et les questions bloquantes
   répondues : une réponse modifiée repasse toujours par la compréhension.
3. **Plan structuré.** Claude remplit un schéma JSON imposé (`--json-schema`) :
   compréhension, couverture des critères, étapes, tests, dépendances et
   risques, exécution. Le plan passe alors en tête du panneau, la
   compréhension dessous ; « Réécrire tout le plan » est au bas du plan.
4. **Revue par section.** « Commenter » renvoie ton commentaire dans la même
   session, avec la consigne de ne modifier que cette section. Le code le
   garantit : de la réponse, seules les clés de la section sont gardées. Une
   reprise des étapes peut aussi renuméroter la couverture, rien d'autre.
   Chaque reprise crée une version.

   La compréhension et le plan se replient d'un clic sur leur titre. Ils se
   replient d'eux-mêmes le temps d'une demande à Claude, et se rouvrent quand
   la réponse arrive : nouvelle question pour la compréhension, nouvelle
   version pour le plan, ou erreur.
5. **Validation.** La checklist sépare la **forme**, vérifiée automatiquement,
   du **fond**, que tu coches section par section (« relu »). Une section qui
   change doit être relue à nouveau ; « Tout marquer relu » les coche d'un
   coup. « Passer en ready » génère la fiche depuis
   le gabarit et la place dans `ready/`.

## Contrôles de forme

| Contrôle | Gravité |
| --- | --- |
| Critère de la fiche (C1, C2…) relié à aucune étape existante | erreur |
| Couverture qui renvoie à une étape inexistante | erreur |
| Dépendance déclarée dans la fiche sans verdict | erreur |
| Aucune étape, aucun test, reformulation vide | erreur |
| Fiche sans critère et plan qui n'en extrait aucun | erreur |
| Critères extraits par Claude (X1, X2…), absents de la source | avertissement |
| Étape qui ne cite aucun fichier | avertissement |
| Étape de worktree, commit, PR, merge ou fermeture du ticket : c'est à DevBots | avertissement |

Le plan ne couvre que le travail de l'agent : code, tests, CR. Claude en est
prévenu, même quand le `CLAUDE.md` ou les docs du dépôt décrivent un workflow
manuel avec PR et revue ; l'agent de dev et la revue du CR ignorent ces
étapes si un plan en contient encore.

Les critères sont lus dans la section « Critères d'acceptation » de la fiche :
ses éléments de liste, ou à défaut ses lignes.

## Sessions

Une seule session Claude Code par planification : la compréhension l'ouvre,
les réponses et les commentaires la reprennent (`--resume`). Le nombre de
reprises est plafonné par `devbots.planning.maxResumes` ; au-delà,
« Recommencer » ouvre une session neuve, en gardant les versions du plan.

Fermer l'onglet arrête l'appel en cours. « Annuler » aussi.

Si `devbots.planning.skill` est renseigné, le premier prompt commence par
`/<skill>` : ton skill de planification guide Claude, la forme de la réponse
restant imposée par le schéma.

Le skill tient alors la méthode, et DevBots ne garde que le contrat : la fiche
et ses critères, les deux phases, le format du plan et l'absence d'étapes de
worktree, de commit ou de merge. Sans skill, DevBots donne une méthode
générique (explorer le code, prévoir les tests, choisir le modèle). L'outil
`Skill` permet au skill du dépôt d'en appeler d'autres, toujours en lecture
seule : un skill appelé n'a pas plus d'outils que la session.

## `.work/plans/<id>/`

| Fichier | Contenu |
| --- | --- |
| `session.json` | Phase, session Claude, compréhension, réponses, versions, sections relues |
| `v<n>.json` | Le plan structuré de la version n |
| `v<n>.md` | Le même en markdown, pour la lecture et le diff natif de VS Code |
| `history.jsonl` | Les échanges, une ligne par événement |

Une planification interrompue reprend là où elle s'était arrêtée, y compris le
lendemain.

## Fiche de `ready/`

Le frontmatter de la fiche d'origine est gardé, complété de ce que
l'orchestrateur réutilisera en phase 3 :

```yaml
planned_at: "2026-10-14T09:00:00.000Z"
plan: plans/42/v3.json
plan_version: 3
recommended_model: sonnet
complexity: low
dependencies_confirmed: ["40"]
dependencies_refuted: []
files: [src/app/email.validator.ts, src/app/signup.component.html]
```

`needs_review` et `source_rev_seen` sont retirés : la story vient d'être
replanifiée.

## Gabarit

Le gabarit du plan se choisit comme les autres (voir [Gabarits](gabarits.md)) :
`devbots.planning.template` s'il est renseigné, sinon `templates/plan.md` du
dossier du flux, sinon le gabarit par défaut. Marqueurs reconnus :

| Marqueur | Contenu |
| --- | --- |
| `{{title}}`, `{{source_id}}`, `{{web_url}}` | Depuis la fiche |
| `{{story}}` | Le corps de la fiche d'origine, sans son titre |
| `{{comprehension}}` | Reformulation, hypothèses, décisions |
| `{{couverture}}` | Critères et étapes qui les couvrent |
| `{{etapes}}` | Étapes numérotées, approche, fichiers |
| `{{tests}}` | Tests unitaires et e2e |
| `{{dependances}}` | Verdicts sur les dépendances, risques |
| `{{execution}}` | Modèle recommandé, complexité, justification |
| `{{plan}}` | Toutes les sections, chacune sous un titre `##` |
| `{{modele}}`, `{{complexite}}` | Valeurs brutes (`sonnet`, `low`…) |

Un marqueur inconnu reste tel quel dans la fiche, pour être repéré.

## Contenu importé

La description d'une story est une donnée, pas une instruction : le prompt
système de chaque appel le rappelle, et Claude n'a pendant la planification que
des outils de lecture. Il ne peut ni écrire ni lancer de commande.
