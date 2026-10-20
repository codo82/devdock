// Git: repository dei progetti npm, status con selezione dei file, commit,
// grafo dei commit con legenda dei branch e operazioni remote con output in streaming.

const AUTO_REFRESH_MS = 30000;

// Palette colori per le lane del grafo (ciclica)
const GRAPH_COLORS = ['#3fb950', '#388bfd', '#bc8cff', '#f0883e', '#58a6ff', '#56d364', '#d2a8ff', '#ffa657', '#79c0ff', '#f778ba'];

// Nome di branch più adatto tra i ref di un commit: niente tag né HEAD nudo,
// "HEAD -> x" diventa x, a parità preferisce il nome più corto (main su origin/main)
function bestBranchRef(refs) {
  const names = (refs || [])
    .filter(r => !r.startsWith('tag: ') && r !== 'HEAD' && !r.endsWith('/HEAD'))
    .map(r => r.replace(/^HEAD -> /, ''));
  return names.sort((a, b) => a.length - b.length)[0] || null;
}

// Branch unito da un merge commit, ricavato dal messaggio standard di git/GitHub/GitLab
function mergedBranchName(subject) {
  const patterns = [
    /^Merge (?:remote-tracking )?branch '([^']+)'/, // git merge
    /^Merge pull request #\d+ from [^/\s]+\/(\S+)/, // GitHub
    /^Merge branch "([^"]+)"/,
  ];
  for (const re of patterns) {
    const m = re.exec(subject || '');
    if (m) return m[1];
  }
  return null;
}

// Assegna ogni commit a una lane e disegna una riga SVG per commit.
// lanes[i] = hash del commit atteso in quella lane; laneNames[i] = branch che la percorre.
function buildGraph(entries, allRefs = {}) {
  const ROW_H = 26, COL_W = 16, R = 4, STROKE = 1.5;
  const laneColor = {}; // lane → indice nella palette
  let colorCounter = 0;
  const assignColor = lane => {
    if (laneColor[lane] === undefined) laneColor[lane] = colorCounter++ % GRAPH_COLORS.length;
  };
  const colorOf = lane => GRAPH_COLORS[laneColor[lane] ?? (lane % GRAPH_COLORS.length)];

  const lanes = [];
  const laneNames = [];

  const rows = entries.map(e => {
    const { hash, parents } = e;

    let myLane = lanes.indexOf(hash);
    if (myLane === -1) {
      // Nessuna lane lo aspettava: nuova lane (o slot libero riciclato)
      myLane = lanes.indexOf(null);
      if (myLane === -1) myLane = lanes.length;
      lanes[myLane] = hash;
      laneNames[myLane] = null; // il nome del branch precedente non vale più
    }

    // Un ref sul commit vince, altrimenti il nome si eredita dalla lane
    const name = bestBranchRef(e.refs) || laneNames[myLane] || null;
    assignColor(myLane);
    const myColor = colorOf(myLane);
    const lanesIn = [...lanes];

    // Il primo parent continua la lane (con il suo nome)
    lanes[myLane] = parents[0] || null;
    laneNames[myLane] = parents[0] ? name : null;

    // Parent aggiuntivi (merge): slot libero o nuova lane
    const mergedName = mergedBranchName(e.subject);
    for (let p = 1; p < parents.length; p++) {
      const parentHash = parents[p];
      if (!lanes.includes(parentHash)) {
        let free = lanes.indexOf(null);
        if (free !== -1) {
          lanes[free] = parentHash;
          laneColor[free] = colorCounter++ % GRAPH_COLORS.length; // slot riciclato: nuovo colore
        } else {
          free = lanes.length;
          assignColor(free);
          lanes.push(parentHash);
        }
        // Il ramo unito prende il nome dal messaggio di merge
        laneNames[free] = p === 1 ? mergedName : null;
      } else if (p === 1 && mergedName) {
        const idx = lanes.indexOf(parentHash);
        if (!laneNames[idx]) laneNames[idx] = mergedName;
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); laneNames.pop(); }

    const lanesOut = [...lanes];
    return { e, myLane, myColor, lanesIn, lanesOut, maxLanes: Math.max(lanesIn.length, lanesOut.length, myLane + 1), name };
  });

  // Stato delle lane dopo l'ultimo commit: hash dei parent attesi fuori dal range
  const finalLanes = [...lanes];
  const width = Math.min(rows.reduce((m, r) => Math.max(m, r.maxLanes), 1), 10) * COL_W + 8;
  const cx = lane => lane * COL_W + COL_W / 2 + 4;

  const svgs = rows.map(({ e, myLane, myColor, lanesIn, lanesOut }) => {
    const H = ROW_H, mid = H / 2, parts = [];

    // Lane che passano dritte
    for (const i of new Set([...lanesIn.keys(), ...lanesOut.keys()])) {
      if (i === myLane || !lanesIn[i] || lanesIn[i] !== lanesOut[i]) continue;
      parts.push(`<line x1="${cx(i)}" y1="0" x2="${cx(i)}" y2="${H}" stroke="${colorOf(i)}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    }

    // Connettori verso i parent
    e.parents.forEach((ph, pi) => {
      const target = lanesOut.indexOf(ph);
      if (target === -1) return;
      const x1 = cx(myLane), y1 = mid + R + 1, x2 = cx(target), y2 = H;
      const color = pi === 0 ? myColor : colorOf(target);
      parts.push(x1 === x2
        ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`
        : `<path d="M${x1},${y1} C${x1},${y2} ${x2},${y1} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    });

    // Linea in entrata
    if (lanesIn[myLane] === e.hash) {
      parts.push(`<line x1="${cx(myLane)}" y1="0" x2="${cx(myLane)}" y2="${mid - R - 1}" stroke="${myColor}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    }

    // Nodo (HEAD con doppio cerchio)
    const nx = cx(myLane);
    if ((e.refs || []).some(r => r.startsWith('HEAD'))) {
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R + 1}" fill="${myColor}" stroke="${myColor}" stroke-width="${STROKE}"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 1}" fill="var(--bg)"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 3}" fill="${myColor}"/>`);
    } else {
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R}" fill="var(--bg)" stroke="${myColor}" stroke-width="${STROKE}"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 2.5}" fill="${myColor}"/>`);
    }
    return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" class="git-graph-svg">${parts.join('')}</svg>`;
  });

  // Legenda: una voce per branch. Righe senza nome: hash atteso a fine range
  // (allRefs mappa i tip dei branch), poi "branch-N" come ultima risorsa.
  const legend = [];
  const seen = new Set();
  for (const { myLane, myColor, name } of rows) {
    let label = name;
    if (!label) {
      const names = finalLanes[myLane] && allRefs[finalLanes[myLane]];
      label = names ? bestBranchRef(names) : `branch-${myLane + 1}`;
    }
    if (seen.has(label)) continue;
    seen.add(label);
    legend.push({ color: myColor, label });
  }

  return { svgs, width, legend };
}

const XY_CLASS = { M: 'xy-M', A: 'xy-A', D: 'xy-D', R: 'xy-R', '?': 'xy-untracked' };

function xyLabel(xy) {
  const t = xy.trim();
  if (t === '??') return '?';
  return t[0] || '?';
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output } = ctx.ui;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);

    let repos = [];
    let activeRepo = null;
    let status = null;
    let selected = new Set();
    let logEntries = [];
    let timer = null;

    const repo = () => repos.find(r => r.id === activeRepo) || null;
    const repoUrl = (suffix = '') => `/repos/${encodeURIComponent(activeRepo)}${suffix}`;
    const remote = () => $('remote').value.trim() || 'origin';

    // ---- repository ----
    async function loadRepos() {
      try { repos = await ctx.api.get('/repos'); } catch { repos = []; }
      ctx.setBadge(repos.length);
      if (activeRepo && !repo()) activeRepo = null;
      renderRepos();
    }

    function renderRepos() {
      const el = ctx.sidebar.querySelector('[data-role="repos"]');
      el.innerHTML = !repos.length
        ? '<p class="git-muted git-pad">Nessun repo git trovato.<br><br>Aggiungi un progetto nella sezione NPM: se è dentro un repository git apparirà qui.</p>'
        : repos.map(r => `
          <button class="sb-item ${activeRepo === r.id ? 'active' : ''}" onclick="Ext.git.select(${js(r.id)})">
            <span class="sb-icon">🌿</span>
            <span class="git-repo-name">${esc(r.label)}</span>
          </button>`).join('');
    }

    function renderRepo() {
      const r = repo();
      $('empty').hidden = !!r;
      $('repo').hidden = !r;
      if (!r) return;
      renderHeader();
    }

    // ---- status ----
    async function loadStatus() {
      if (!activeRepo) return;
      try { status = await ctx.api.get(repoUrl('/status')); } catch { status = null; }
      renderHeader();
      renderFiles();
    }

    function renderHeader() {
      const r = repo();
      if (!r) return;
      $('header').innerHTML = `
        <h3>🌿 ${esc(r.label)}</h3>
        ${status ? `<span class="git-branch-badge">⎇ ${esc(status.branch)}</span>
          ${status.ahead ? `<span class="git-sync-badge git-sync-ahead">↑${esc(status.ahead)} ahead</span>` : ''}
          ${status.behind ? `<span class="git-sync-badge git-sync-behind">↓${esc(status.behind)} behind</span>` : ''}
          ${status.stashCount ? `<span class="git-sync-badge git-sync-stash">📦 ${esc(status.stashCount)} stash</span>` : ''}` : ''}
        <span class="git-path">${esc(r.path)}</span>`;
    }

    function renderFiles() {
      const el = $('files');
      const toggle = $('toggle-all');
      if (!status) { el.innerHTML = '<div class="git-muted git-pad">Nessun dato</div>'; return; }
      if (!status.files.length) {
        el.innerHTML = '<div class="git-clean"><div class="git-clean-icon">✓</div>Working tree pulito</div>';
        toggle.textContent = '☐ All';
        return;
      }
      el.innerHTML = status.files.map(f => {
        const sel = selected.has(f.name);
        const parts = f.name.split('/');
        const label = xyLabel(f.xy);
        return `<div class="git-file ${sel ? 'selected' : ''}" onclick="Ext.git.toggleFile(${js(f.name)})" title="${esc(f.name)}">
          <span class="git-file-check">${sel ? '☑' : '☐'}</span>
          <span class="git-file-xy ${XY_CLASS[label] || ''}">${esc(label)}</span>
          <span class="git-file-name">${esc(parts[parts.length - 1])}</span>
          ${parts.length > 1 ? `<span class="git-file-dir">${esc(parts.slice(0, -1).join('/'))}/</span>` : ''}
        </div>`;
      }).join('');
      toggle.textContent = status.files.every(f => selected.has(f.name)) ? '☑ All' : '☐ All';
    }

    // ---- log e grafo ----
    const refClass = ref => ref.startsWith('HEAD') ? 'git-ref-head'
      : ref.startsWith('tag:') ? 'git-ref-tag'
      : ref.includes('/') ? 'git-ref-remote' : 'git-ref-local';
    const refBadges = refs => (refs || []).map(ref => `<span class="git-ref ${refClass(ref)}">${esc(ref.replace('tag: ', ''))}</span>`).join('');

    async function loadLog() {
      const wrap = $('log');
      if (!activeRepo) return;
      wrap.innerHTML = '<div class="git-muted git-pad">Caricamento...</div>';
      try {
        const data = await ctx.api.get(repoUrl(`/log?limit=${encodeURIComponent($('limit').value)}`));
        const entries = data.entries || [];
        const allRefs = data.refs || {};
        logEntries = entries;
        if (!entries.length) { wrap.innerHTML = '<div class="git-muted git-pad">Nessun commit</div>'; $('legend').hidden = true; return; }

        const { svgs, width, legend } = buildGraph(entries, allRefs);
        const local = new Set(data.localBranches || []);
        // Remoti = ref esistenti non locali (un branch unito e cancellato non è né l'uno né l'altro)
        const remoteRefs = new Set(Object.values(allRefs).flat().filter(n => !local.has(n)));

        const legendEl = $('legend');
        legendEl.hidden = !legend.length;
        legendEl.innerHTML = legend.map(({ color, label }) => {
          const anon = /^branch-\d+$/.test(label);
          const icon = anon ? '●' : label === status?.branch ? '◉' : remoteRefs.has(label) ? '↗' : '⎇';
          return `<span class="git-legend-item ${anon ? 'anon' : ''}" style="--lane:${color}">${icon} ${esc(label)}</span>`;
        }).join('');

        wrap.innerHTML = `<table class="git-log-table" style="--graph-w:${width}px">
          <colgroup><col class="col-graph"><col class="col-hash"><col class="col-msg"><col class="col-author"><col class="col-date"></colgroup>
          <thead><tr><th></th><th>SHA</th><th>Messaggio</th><th>Autore</th><th>Data</th></tr></thead>
          <tbody>${entries.map((e, i) => `
            <tr class="git-log-row" onclick="Ext.git.showCommit(${i})">
              <td class="git-graph-cell">${svgs[i]}</td>
              <td><span class="git-hash" title="${esc(e.hash)}">${esc(e.short)}</span></td>
              <td class="git-msg-cell"><span class="git-subject">${refBadges(e.refs)}${esc(e.subject)}</span></td>
              <td class="git-author">${esc(e.author)}</td>
              <td class="git-date">${esc(e.relDate)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
      } catch (e) {
        wrap.innerHTML = `<div class="git-error git-pad">Errore: ${esc(e.message)}</div>`;
      }
    }

    function showCommit(idx) {
      const e = logEntries[idx];
      if (!e) return;
      ctx.root.querySelectorAll('.git-log-row').forEach((r, i) => r.classList.toggle('git-row-active', i === idx));
      ctx.root.querySelector('.git-commit-drawer')?.remove();
      const drawer = document.createElement('div');
      drawer.className = 'git-commit-drawer';
      drawer.innerHTML = `
        <div class="git-drawer-main">
          <div class="git-drawer-subject">${refBadges(e.refs)}${esc(e.subject)}</div>
          <div class="git-drawer-body" data-role="commit-body"></div>
          <div class="git-drawer-meta">
            <span>👤 ${esc(e.author)}</span>
            <span>🕐 ${esc(e.relDate)}</span>
            <span class="git-mono">SHA: <span class="git-hash" onclick="navigator.clipboard&&navigator.clipboard.writeText(${js(e.hash)})" title="Click per copiare">${esc(e.hash)}</span></span>
            ${e.parents?.length ? `<span class="git-mono">Parent: ${e.parents.map(p => `<span class="git-hash">${esc(p.slice(0, 7))}</span>`).join(' ')}</span>` : ''}
          </div>
        </div>
        <button class="git-drawer-close" title="Chiudi" onclick="this.closest('.git-commit-drawer').remove()">✕</button>`;
      ctx.root.querySelector('.git-log-col').appendChild(drawer);

      // Corpo completo del commit (git show restituisce subject + riga vuota + body)
      ctx.api.get(repoUrl(`/commit/${encodeURIComponent(e.hash)}`)).then(data => {
        const lines = (data.body || '').split('\n');
        let start = 1;
        while (start < lines.length && !lines[start].trim()) start++;
        const body = lines.slice(start).join('\n').trimEnd();
        const el = drawer.querySelector('[data-role="commit-body"]');
        if (el && body) el.textContent = body;
      }).catch(() => {});
    }

    // ---- azioni git con output in streaming ----
    async function run(body, title) {
      if (title) output.open(title);
      let exit = 1;
      try {
        exit = await ctx.api.stream(repoUrl('/action'), body, ({ type, data }) => {
          if (type === 'stdout') output.append(data, 'out');
          else if (type === 'stderr') output.append(data, 'err');
          else if (type === 'error') output.append(`\nErrore: ${data}\n`, 'err');
          else if (type === 'exit') output.append(`\n[exit ${data}]`, 'sys');
        });
      } catch (e) {
        output.append(`\nErrore: ${e.message}\n`, 'err');
      }
      setTimeout(reload, 400); // status e log aggiornati dopo ogni operazione
      return exit ?? 1;
    }

    async function gitAction(action) {
      if (action === 'push' || action === 'pull_push') await loadStatus(); // branch aggiornato
      run({ action, remote: remote(), branch: status?.branch }, `git ${action} (${remote()})`);
    }

    async function commit(andPush) {
      const msgEl = $('message');
      const message = msgEl.value.trim();
      if (!message) { toast('Inserisci un messaggio di commit', 'error'); return; }
      const branch = status?.branch;
      output.open(andPush ? 'git commit & push' : 'git commit');
      const exit = await run({ action: 'commit', message, files: [...selected], remote: remote(), branch });
      if (andPush) {
        if (exit !== 0) output.append('\n[push annullato: commit fallito]\n', 'sys');
        else { output.append(`\n$ git push ${remote()} ${branch || ''}\n`, 'sys'); await run({ action: 'push', remote: remote(), branch }); }
      }
      msgEl.value = '';
      selected.clear();
    }

    function openMerge() {
      openModal('Merge branch', `
        <div class="form-row">
          <label>Branch da fare merge nel branch corrente (${esc(status?.branch || '?')})</label>
          <input class="form-input" id="f_merge_branch" placeholder="es. main, develop, feature/xyz">
        </div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button>
         <button class="btn btn-git" onclick="Ext.git.merge()">⑃ Merge</button>`);
    }

    async function reload() {
      await loadStatus();
      await loadLog();
    }

    // ---- collegamenti ----
    const actions = {
      async select(id) {
        activeRepo = id;
        status = null;
        selected = new Set();
        ctx.root.querySelector('.git-commit-drawer')?.remove(); // dettaglio del repo precedente
        renderRepos();
        renderRepo();
        await reload();
      },
      toggleFile(name) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        renderFiles();
      },
      showCommit,
      merge() {
        const branch = (document.getElementById('f_merge_branch')?.value || '').trim();
        if (!branch) { toast('Specifica un branch', 'error'); return; }
        closeModal();
        run({ action: 'merge', branch }, `git merge ${branch}`);
      },
    };

    ctx.root.addEventListener('click', e => {
      const git = e.target.closest('[data-git]')?.dataset.git;
      if (git) return gitAction(git);
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'reload') reload();
      else if (a === 'merge') openMerge();
      else if (a === 'commit') commit(false);
      else if (a === 'commit-push') commit(true);
      else if (a === 'toggle-all' && status) {
        if (status.files.every(f => selected.has(f.name))) selected.clear();
        else status.files.forEach(f => selected.add(f.name));
        renderFiles();
      }
    });
    $('limit').addEventListener('change', loadLog);
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="reload-repos"]')) this.refresh();
    });
    // nuovi progetti npm possono aggiungere repository
    ctx.bus.on('npm:projects-changed', loadRepos);

    ctx.expose(actions);
    await loadRepos();
    renderRepo();

    this.show = async () => {
      await loadRepos();
      renderRepo();
      if (activeRepo) reload();
      clearInterval(timer);
      timer = setInterval(() => { if (activeRepo) reload(); }, AUTO_REFRESH_MS);
    };
    this.hide = () => { clearInterval(timer); timer = null; };
    this.refresh = async () => { await loadRepos(); renderRepo(); if (activeRepo) await reload(); };
  },
};
