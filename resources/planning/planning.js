// Page de l'atelier de planification.
//
// Elle ne tient aucun état métier : l'extension envoie l'état complet après
// chaque changement, la page le dessine et renvoie les gestes. Seuls les
// brouillons de saisie (commentaires, réponses libres) vivent ici, pour survivre
// aux redessins. Tout texte passe par textContent : le contenu des tickets ne
// peut pas injecter de balises.

// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** Brouillons de saisie : clé → texte. */
  const drafts = Object.assign({ comments: {}, answers: {}, open: {} }, vscode.getState() || {});
  let state = null;

  const saveDrafts = () => vscode.setState(drafts);
  const send = (msg) => vscode.postMessage(msg);

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      state = event.data.state;
      render();
    }
  });
  send({ type: 'ready' });

  /* ------------------------------------------------------------ */
  /* Petits constructeurs                                          */
  /* ------------------------------------------------------------ */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function button(label, onclick, opts) {
    const o = opts || {};
    return el(
      'button',
      {
        class: o.secondary ? 'secondary' : o.link ? 'link' : undefined,
        disabled: Boolean(state.busy) || o.disabled,
        title: o.title,
        onclick
      },
      label
    );
  }

  function list(items, empty) {
    if (!items || items.length === 0) return empty ? el('p', { class: 'muted' }, empty) : null;
    return el('ul', null, items.map((i) => el('li', null, i)));
  }

  function card(title, ...children) {
    return el('section', { class: 'card' }, el('h2', null, title), ...children);
  }

  /* ------------------------------------------------------------ */
  /* Rendu                                                         */
  /* ------------------------------------------------------------ */

  function render() {
    if (!state || !app) return;
    const scrollY = window.scrollY;
    app.replaceChildren(
      header(),
      state.busy ? busyBanner() : null,
      state.error ? el('div', { class: 'banner error', role: 'alert' }, state.error) : null,
      state.phase === 'validated'
        ? el('div', { class: 'banner ok' }, 'Plan validé : la story est dans ready/.')
        : null,
      understandingCard(),
      state.plan ? planCard() : null,
      state.plan ? versionsCard() : null,
      state.plan && state.phase !== 'validated' ? validationCard() : null,
      historyCard()
    );
    window.scrollTo(0, scrollY);
  }

  function header() {
    const meta = [];
    meta.push(phaseLabel(state.phase));
    if (state.version) meta.push(`plan v${state.version}`);
    if (state.hasSession) meta.push(`${state.resumes} reprise${state.resumes > 1 ? 's' : ''}`);
    return el(
      'header',
      null,
      el('h1', null, `${state.storyId} — ${state.title}`),
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'muted' }, meta.join(' · ')),
        el('span', { class: 'spacer' }),
        button('Ouvrir la fiche', () => send({ type: 'openStory' }), { secondary: true }),
        state.hasSession && state.phase !== 'validated'
          ? button('Recommencer', () => send({ type: 'restart' }), {
              secondary: true,
              title: 'Nouvelle session Claude, réponses effacées'
            })
          : null
      )
    );
  }

  function phaseLabel(phase) {
    return { understanding: 'Compréhension', planning: 'Revue du plan', validated: 'Validé' }[phase] || phase;
  }

  function busyBanner() {
    return el(
      'div',
      { class: 'banner busy', role: 'status' },
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', null, state.busy),
      el('span', { class: 'spacer' }),
      el('button', { class: 'secondary', onclick: () => send({ type: 'cancel' }) }, 'Annuler')
    );
  }

  /* --- Compréhension ------------------------------------------- */

  function understandingCard() {
    const u = state.understanding;
    const locked = state.phase === 'validated';
    if (!u) {
      return card(
        '1. Compréhension',
        el(
          'p',
          null,
          "Claude lit la fiche et le code utile, puis renvoie sa reformulation, ses hypothèses et ses questions. Le plan ne sera rédigé qu'une fois les questions bloquantes répondues."
        ),
        criteriaBlock(),
        locked ? null : button('Lancer la compréhension', () => send({ type: 'understand' }))
      );
    }

    const questions = u.questions.map((q) => questionBlock(q, locked));
    const pending = u.questions.filter((q) => q.blocking && !answered(q.id)).length;

    return card(
      '1. Compréhension',
      el('p', { class: 'restatement' }, u.restatement),
      u.assumptions.length ? el('h3', null, 'Hypothèses') : null,
      list(u.assumptions),
      u.questions.length ? el('h3', null, 'Questions') : el('p', { class: 'muted' }, 'Aucune question : tout est clair pour Claude.'),
      ...questions,
      locked
        ? null
        : el(
            'div',
            { class: 'row actions' },
            u.questions.length
              ? button('Renvoyer mes réponses', () => send({ type: 'understand' }), {
                  secondary: true,
                  title: 'Claude met à jour sa compréhension, et peut poser de nouvelles questions'
                })
              : null,
            button(state.plan ? 'Réécrire tout le plan' : 'Rédiger le plan', () => send({ type: 'draft' }), {
              disabled: !state.canDraft
            }),
            pending > 0
              ? el('span', { class: 'muted' }, `${pending} question${pending > 1 ? 's' : ''} bloquante${pending > 1 ? 's' : ''} sans réponse`)
              : null
          )
    );
  }

  function criteriaBlock() {
    if (!state.criteria.length) {
      return el('p', { class: 'muted' }, "La fiche n'a pas de critère d'acceptation : Claude les extraira de la description.");
    }
    return el(
      'details',
      null,
      el('summary', null, `${state.criteria.length} critère${state.criteria.length > 1 ? 's' : ''} d'acceptation dans la fiche`),
      el('ol', null, state.criteria.map((c) => el('li', null, c)))
    );
  }

  function answered(id) {
    const a = state.answers[id];
    return Boolean(a && ((a.choice && a.choice.trim()) || (a.text && a.text.trim())));
  }

  function questionBlock(q, locked) {
    const current = state.answers[q.id] || {};
    const name = `q-${q.id}`;
    const textDraft = drafts.answers[q.id] !== undefined ? drafts.answers[q.id] : current.text || '';

    const commit = (patch) => {
      const next = Object.assign({}, state.answers[q.id] || {}, patch);
      send({ type: 'answer', id: q.id, answer: next });
    };

    const choices = q.choices.map((choice, i) =>
      el(
        'label',
        { class: 'choice' },
        el('input', {
          type: 'radio',
          name,
          id: `${name}-${i}`,
          checked: current.choice === choice,
          disabled: locked || Boolean(state.busy),
          onchange: () => commit({ choice })
        }),
        choice
      )
    );
    if (current.choice && !locked) {
      choices.push(button('Effacer le choix', () => commit({ choice: '' }), { link: true }));
    }

    const text = el('textarea', {
      rows: 2,
      placeholder: 'Réponse libre, ou précision sur le choix',
      disabled: locked || Boolean(state.busy),
      oninput: (e) => {
        drafts.answers[q.id] = e.target.value;
        saveDrafts();
      },
      onchange: (e) => {
        delete drafts.answers[q.id];
        saveDrafts();
        commit({ text: e.target.value });
      }
    });
    text.value = textDraft;

    return el(
      'div',
      { class: `question${answered(q.id) ? ' done' : ''}` },
      el(
        'div',
        { class: 'question-title' },
        el('strong', null, q.id),
        ' ',
        q.question,
        q.blocking ? el('span', { class: 'badge error' }, 'bloquante') : el('span', { class: 'badge' }, 'facultative')
      ),
      el('div', { class: 'choices' }, choices),
      text
    );
  }

  /* --- Plan ---------------------------------------------------- */

  function planCard() {
    return card(
      `2. Plan v${state.version}`,
      el(
        'p',
        { class: 'muted' },
        "Commente une section pour la faire reprendre par Claude : seule cette section change. Coche « relu » quand le fond te va."
      ),
      ...state.sections.map((s) => sectionBlock(s.id, s.label))
    );
  }

  function sectionBlock(id, label) {
    const checks = state.checks.filter((c) => c.section === id);
    const errors = checks.filter((c) => c.severity === 'error');
    const locked = state.phase === 'validated';
    const isOpen = Boolean(drafts.open[id]);

    const reviewed = el('label', { class: 'reviewed' },
      el('input', {
        type: 'checkbox',
        checked: Boolean(state.reviewed[id]),
        disabled: locked || Boolean(state.busy),
        onchange: (e) => send({ type: 'reviewed', section: id, value: e.target.checked })
      }),
      'relu'
    );

    let commentBox = null;
    if (isOpen && !locked) {
      const area = el('textarea', {
        rows: 3,
        placeholder: `Ce qui ne va pas dans « ${label} »`,
        disabled: Boolean(state.busy),
        oninput: (e) => {
          drafts.comments[id] = e.target.value;
          saveDrafts();
        }
      });
      area.value = drafts.comments[id] || '';
      commentBox = el(
        'div',
        { class: 'comment' },
        area,
        el(
          'div',
          { class: 'row' },
          button('Envoyer à Claude', () => {
            const comment = (drafts.comments[id] || '').trim();
            if (!comment) return;
            delete drafts.comments[id];
            drafts.open[id] = false;
            saveDrafts();
            send({ type: 'revise', section: id, comment });
          }),
          button('Annuler', () => {
            drafts.open[id] = false;
            saveDrafts();
            render();
          }, { secondary: true })
        )
      );
    }

    return el(
      'article',
      { class: `section${errors.length ? ' has-error' : ''}` },
      el(
        'div',
        { class: 'section-head' },
        el('h3', null, label),
        errors.length ? el('span', { class: 'badge error' }, `${errors.length} erreur${errors.length > 1 ? 's' : ''}`) : null,
        el('span', { class: 'spacer' }),
        locked || isOpen
          ? null
          : button('Commenter', () => {
              drafts.open[id] = true;
              saveDrafts();
              render();
            }, { link: true }),
        reviewed
      ),
      checks.length ? el('ul', { class: 'checks' }, checks.map((c) => el('li', { class: c.severity }, c.message))) : null,
      sectionContent(id),
      commentBox
    );
  }

  function sectionContent(id) {
    const p = state.plan;
    switch (id) {
      case 'understanding':
        return el(
          'div',
          null,
          el('p', null, p.understanding.restatement),
          p.understanding.assumptions.length ? el('h4', null, 'Hypothèses') : null,
          list(p.understanding.assumptions),
          p.understanding.decisions.length ? el('h4', null, 'Décisions') : null,
          list(p.understanding.decisions)
        );
      case 'coverage':
        return p.coverage.length
          ? el(
              'table',
              null,
              el('thead', null, el('tr', null, el('th', null, 'Critère'), el('th', null, 'Étapes'))),
              el(
                'tbody',
                null,
                p.coverage.map((c) =>
                  el(
                    'tr',
                    null,
                    el('td', null, el('strong', null, c.criterion_id), ' ', c.criterion),
                    el('td', null, c.step_ids.length ? c.step_ids.join(', ') : '—')
                  )
                )
              )
            )
          : el('p', { class: 'muted' }, 'Aucun critère relié.');
      case 'steps':
        return el(
          'ol',
          { class: 'steps' },
          p.steps.map((s) =>
            el(
              'li',
              { value: s.id },
              el('strong', null, s.title),
              el('p', null, s.approach),
              s.files.length ? el('div', { class: 'files' }, s.files.map((f) => el('code', null, f))) : null
            )
          )
        );
      case 'tests':
        return el(
          'div',
          null,
          el('h4', null, 'Unitaires'),
          list(p.tests.unit, 'Aucun.'),
          el('h4', null, 'E2E'),
          list(p.tests.e2e, 'Aucun.')
        );
      case 'dependencies':
        return el(
          'div',
          null,
          el('h4', null, 'Dépendances déclarées'),
          p.dependencies.length
            ? el(
                'ul',
                null,
                p.dependencies.map((d) =>
                  el(
                    'li',
                    null,
                    el('strong', null, d.source_id),
                    ' ',
                    el('span', { class: `badge ${d.verdict === 'confirmed' ? 'warn' : 'ok'}` }, d.verdict === 'confirmed' ? 'confirmée' : 'infirmée — parallélisable'),
                    ' ',
                    d.reason
                  )
                )
              )
            : el('p', { class: 'muted' }, 'Aucune.'),
          el('h4', null, 'Risques'),
          list(p.risks, 'Aucun.')
        );
      case 'execution': {
        const models = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
        const complexity = { low: 'faible', medium: 'moyenne', high: 'élevée' };
        return el(
          'div',
          null,
          el(
            'p',
            null,
            'Modèle recommandé : ',
            el('strong', null, models[p.execution.model] || p.execution.model),
            ' · complexité ',
            el('strong', null, complexity[p.execution.complexity] || p.execution.complexity)
          ),
          p.execution.rationale ? el('p', { class: 'muted' }, p.execution.rationale) : null
        );
      }
      default:
        return null;
    }
  }

  /* --- Versions ------------------------------------------------ */

  function versionsCard() {
    const versions = state.versions.slice().reverse();
    return card(
      'Versions',
      el(
        'table',
        { class: 'versions' },
        el(
          'tbody',
          null,
          versions.map((v) =>
            el(
              'tr',
              null,
              el('td', null, el('strong', null, `v${v.version}`)),
              el('td', null, v.reason),
              el('td', { class: 'muted' }, new Date(v.createdAt).toLocaleString('fr-FR')),
              el(
                'td',
                { class: 'right' },
                el('button', { class: 'link', onclick: () => send({ type: 'openVersion', version: v.version }) }, 'voir'),
                v.version > 1
                  ? el('button', { class: 'link', onclick: () => send({ type: 'diff', from: v.version - 1, to: v.version }) }, `diff v${v.version - 1}`)
                  : null
              )
            )
          )
        )
      ),
      state.versions.length > 2 ? diffPicker() : null
    );
  }

  function diffPicker() {
    const options = () => state.versions.map((v) => el('option', { value: v.version }, `v${v.version}`));
    const from = el('select', { 'aria-label': 'Version de départ' }, options());
    const to = el('select', { 'aria-label': "Version d'arrivée" }, options());
    from.value = String(state.versions[0].version);
    to.value = String(state.version);
    return el(
      'div',
      { class: 'row' },
      'Comparer ',
      from,
      ' et ',
      to,
      el('button', { class: 'secondary', onclick: () => send({ type: 'diff', from: Number(from.value), to: Number(to.value) }) }, 'Diff')
    );
  }

  /* --- Validation ---------------------------------------------- */

  function validationCard() {
    const errors = state.checks.filter((c) => c.severity === 'error');
    const warnings = state.checks.filter((c) => c.severity === 'warning');
    const notReviewed = state.sections.filter((s) => !state.reviewed[s.id]);

    return card(
      '3. Validation',
      el(
        'ul',
        { class: 'checklist' },
        el(
          'li',
          { class: errors.length ? 'error' : 'ok' },
          el('strong', null, 'Forme'),
          ' (vérifiée automatiquement) : ',
          errors.length
            ? `${errors.length} erreur${errors.length > 1 ? 's' : ''} à corriger`
            : warnings.length
              ? `valide, ${warnings.length} avertissement${warnings.length > 1 ? 's' : ''}`
              : 'valide'
        ),
        el(
          'li',
          { class: notReviewed.length ? 'error' : 'ok' },
          el('strong', null, 'Fond'),
          ' (coché par toi) : ',
          notReviewed.length ? `à relire — ${notReviewed.map((s) => s.label).join(', ')}` : 'toutes les sections relues'
        )
      ),
      el(
        'div',
        { class: 'row actions' },
        button('Passer en ready', () => send({ type: 'validate' }), { disabled: !state.canValidate }),
        el('span', { class: 'muted' }, 'Génère la fiche depuis le gabarit de plan et la place dans ready/.')
      )
    );
  }

  /* --- Historique ---------------------------------------------- */

  function historyCard() {
    if (!state.history.length) return null;
    return el(
      'details',
      { class: 'card history' },
      el('summary', null, `Historique (${state.history.length})`),
      state.history
        .slice()
        .reverse()
        .map((h) =>
          el(
            'div',
            { class: 'entry' },
            el('div', { class: 'muted' }, `${new Date(h.at).toLocaleString('fr-FR')} · ${h.who} · ${h.kind}`),
            el('pre', null, h.text)
          )
        )
    );
  }
})();
