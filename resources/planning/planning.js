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

  /**
   * Brouillons de saisie (clé → texte) et état d'affichage : sections pliées
   * (folds), sections repliées en attente d'une réponse de Claude (waiting).
   */
  const drafts = Object.assign({ comments: {}, answers: {}, open: {}, folds: {}, waiting: [] }, vscode.getState() || {});
  let state = null;

  const saveDrafts = () => vscode.setState(drafts);
  const send = (msg) => vscode.postMessage(msg);

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      const wasBusy = Boolean(state && state.busy);
      state = event.data.state;
      // Fin d'un appel : en cas d'erreur, les sections repliées pour l'attendre se rouvrent.
      if (wasBusy && !state.busy && drafts.waiting.length) {
        if (state.error) for (const key of drafts.waiting) drafts.folds[key] = true;
        drafts.waiting = [];
        saveDrafts();
      }
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
    return el('ul', null, items.map((i) => el('li', null, inline(i))));
  }

  /**
   * Texte libre de Claude en blocs lisibles : paragraphes séparés par une ligne
   * vide, listes à puces ou numérotées, retours à la ligne gardés. Construit en
   * nœuds, jamais en HTML : le texte reste du texte.
   */
  function prose(text, cls) {
    const blocks = [];
    let para = [];
    let items = null;
    const flushPara = () => {
      if (para.length) blocks.push(el('p', null, para.flatMap((line, i) => (i ? [el('br'), ...inline(line)] : inline(line)))));
      para = [];
    };
    const flushList = () => {
      if (items) blocks.push(el(items.ordered ? 'ol' : 'ul', null, items.lines.map((l) => el('li', null, inline(l)))));
      items = null;
    };
    for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim();
      const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (!line) {
        flushPara();
        flushList();
      } else if (bullet) {
        flushPara();
        const ordered = /^\d/.test(bullet[1]);
        if (items && items.ordered !== ordered) flushList();
        if (!items) items = { ordered, lines: [] };
        items.lines.push(bullet[2]);
      } else if (items && /^\s/.test(raw)) {
        // Suite indentée de l'élément précédent.
        items.lines[items.lines.length - 1] += ` ${line}`;
      } else {
        flushList();
        para.push(line.replace(/^#+\s+/, ''));
      }
    }
    flushPara();
    flushList();
    return el('div', { class: `prose${cls ? ` ${cls}` : ''}` }, blocks);
  }

  /** `code` et **gras** dans une ligne ; le reste en texte brut. */
  function inline(text) {
    const parts = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    let m;
    const s = String(text);
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      parts.push(m[1] !== undefined ? el('code', null, m[1]) : el('strong', null, m[2]));
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
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
    // replaceChildren() convertit null en texte « null » : on filtre comme el().
    const sections = [
      header(),
      state.busy ? busyBanner() : null,
      state.error ? el('div', { class: 'banner error', role: 'alert' }, state.error) : null,
      state.phase === 'validated'
        ? el('div', { class: 'banner ok' }, 'Plan validé : la story est dans ready/.')
        : null,
      // Une fois le plan rédigé, c'est lui qu'on relit d'abord : la compréhension passe dessous.
      ...(state.plan
        ? [
            planCard(),
            state.phase !== 'validated' ? validationCard() : null,
            understandingCard(),
            versionsCard()
          ]
        : [understandingCard()]),
      historyCard()
    ];
    app.replaceChildren(...sections.filter((s) => s !== null));
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
    const answeredCount = u.questions.filter((q) => answered(q.id)).length;

    // Une question jamais vue (identifiant ou libellé) rouvre la section, même repliée.
    const keys = u.questions.map((q) => `${q.id}|${q.question}`);
    if (drafts.seenQuestions && keys.some((k) => !drafts.seenQuestions.includes(k))) {
      drafts.folds.understanding = true;
    }
    drafts.seenQuestions = keys;
    saveDrafts();

    return foldableCard(
      'understanding',
      '1. Compréhension',
      u.questions.length
        ? `${answeredCount}/${u.questions.length} question${u.questions.length > 1 ? 's' : ''} répondue${answeredCount > 1 ? 's' : ''}`
        : null,
      [
        prose(u.restatement, 'restatement'),
        u.assumptions.length ? el('h3', null, 'Hypothèses') : null,
        list(u.assumptions),
        u.questions.length ? el('h3', null, 'Questions') : el('p', { class: 'muted' }, 'Aucune question : tout est clair pour Claude.'),
        ...questions
      ],
      locked
        ? null
        : el(
            'div',
            { class: 'row actions' },
            // Une réponse modifiée passe d'abord par Claude : elle peut soulever d'autres questions.
            u.questions.length
              ? button('Envoyer mes réponses', () => sendCollapsing({ type: 'understand' }, ['understanding']), {
                  secondary: !state.answersUnsent,
                  title: 'Claude met à jour sa compréhension, et peut poser de nouvelles questions'
                })
              : null,
            // Le plan ne se rédige qu'une fois les réponses lues et les questions bloquantes traitées ;
            // sa réécriture est sous le plan.
            state.canDraft && !state.plan
              ? button('Rédiger le plan', () => sendCollapsing({ type: 'draft' }, ['understanding']))
              : null,
            pending > 0
              ? el('span', { class: 'muted' }, `${pending} question${pending > 1 ? 's' : ''} bloquante${pending > 1 ? 's' : ''} sans réponse`)
              : state.answersUnsent
                ? el('span', { class: 'muted' }, 'Réponses à envoyer avant le plan')
                : null
          )
    );
  }

  /**
   * Carte repliable : le titre plie et déplie le contenu, les actions restent
   * dessous, visibles même repliée. L'état vit dans drafts.folds[key].
   */
  function foldableCard(key, title, hint, children, actions) {
    const details = el(
      'details',
      { class: 'collapsible', open: drafts.folds[key] !== false },
      el('summary', null, el('h2', null, title), hint ? el('span', { class: 'muted' }, hint) : null),
      ...children
    );
    details.addEventListener('toggle', () => {
      // Un événement d'une section déjà remplacée par un redessin ne compte pas.
      if (!details.isConnected) return;
      drafts.folds[key] = details.open;
      saveDrafts();
    });
    return el('section', { class: 'card' }, details, actions);
  }

  /**
   * Envoie une demande à Claude et replie les sections concernées le temps de
   * la réponse. Si l'appel échoue, elles se rouvrent.
   */
  function sendCollapsing(msg, keys) {
    for (const key of keys) drafts.folds[key] = false;
    drafts.waiting = keys;
    saveDrafts();
    send(msg);
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
        ...inline(choice)
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
        ...inline(q.question),
        q.blocking ? el('span', { class: 'badge error' }, 'bloquante') : el('span', { class: 'badge' }, 'facultative')
      ),
      el('div', { class: 'choices' }, choices),
      text
    );
  }

  /* --- Plan ---------------------------------------------------- */

  function planCard() {
    // Une nouvelle version, réponse de Claude à un commentaire ou une réécriture, rouvre le plan.
    if (drafts.seenPlanVersion !== undefined && drafts.seenPlanVersion !== state.version) {
      drafts.folds.plan = true;
    }
    drafts.seenPlanVersion = state.version;
    saveDrafts();

    const reviewedCount = state.sections.filter((s) => state.reviewed[s.id]).length;
    return foldableCard(
      'plan',
      `2. Plan v${state.version}`,
      `${reviewedCount}/${state.sections.length} section${state.sections.length > 1 ? 's' : ''} relue${reviewedCount > 1 ? 's' : ''}`,
      [
        el(
          'p',
          { class: 'muted' },
          "Commente une section pour la faire reprendre par Claude : seule cette section change. Coche « relu » quand le fond te va."
        ),
        ...state.sections.map((s) => sectionBlock(s.id, s.label))
      ],
      state.phase === 'validated'
        ? null
        : el(
            'div',
            { class: 'row actions' },
            button('Réécrire tout le plan', () => sendCollapsing({ type: 'draft' }, ['understanding', 'plan']), {
              secondary: true,
              disabled: !state.canDraft,
              title: state.answersUnsent
                ? "Envoie d'abord tes réponses modifiées, dans la compréhension"
                : 'Nouvelle version complète, depuis la compréhension et tes réponses'
            })
          )
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
            sendCollapsing({ type: 'revise', section: id, comment }, ['plan']);
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
          prose(p.understanding.restatement),
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
                    el('td', null, el('strong', null, c.criterion_id), ' ', ...inline(c.criterion)),
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
              el('strong', null, ...inline(s.title)),
              prose(s.approach),
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
                    ...inline(d.reason)
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
          p.execution.rationale ? prose(p.execution.rationale, 'muted') : null
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
        notReviewed.length
          ? button('Tout marquer relu', () => send({ type: 'reviewAll' }), { secondary: true })
          : null,
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
