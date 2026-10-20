// Database: vault della master password, connessioni, editor delle query e risultati

export default {
  async mount(ctx) {
    const { esc, toast, openModal, closeModal } = ctx.ui;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let vault = { state: 'uninitialized', minLength: 10 };

    // ---- vault ----
    async function loadVault() {
      try { vault = await ctx.api.get('/vault'); } catch (e) { toast(e.message, 'error'); }
      render();
    }

    function render() {
      const unlocked = vault.state === 'unlocked';
      $(ctx.root, 'gate').hidden = unlocked;
      $(ctx.root, 'main').hidden = !unlocked;
      $(ctx.sidebar, 'vault-btn').hidden = !unlocked;
      $(ctx.sidebar, 'connections').innerHTML = unlocked ? '' : '<p class="db-muted db-pad">🔒 Sblocca la master password per vedere le connessioni.</p>';
      if (!unlocked) renderGate();
    }

    function renderGate() {
      const creating = vault.state === 'uninitialized';
      $(ctx.root, 'gate-title').textContent = creating ? 'Crea la master password' : 'Database bloccato';
      $(ctx.root, 'gate-text').textContent = creating
        ? `Le password dei database vengono cifrate con questa password. Non viene salvata da nessuna parte: se la dimentichi le password salvate andranno reinserite. Almeno ${vault.minLength} caratteri.`
        : `Inserisci la master password per usare le connessioni. Si blocca da sola dopo ${vault.lockAfterMinutes} minuti di inattività.`;
      $(ctx.root, 'gate-password').placeholder = 'Master password';
      $(ctx.root, 'gate-confirm').hidden = !creating;
      $(ctx.root, 'gate-forgot').hidden = creating;
      $(ctx.root, 'gate-submit').textContent = creating ? 'Crea' : 'Sblocca';
      $(ctx.root, 'gate-error').textContent = '';
      setTimeout(() => $(ctx.root, 'gate-password').focus(), 0);
    }

    async function submitGate(e) {
      e.preventDefault();
      const pwd = $(ctx.root, 'gate-password').value;
      const error = $(ctx.root, 'gate-error');
      if (vault.state === 'uninitialized') {
        if ([...pwd].length < vault.minLength) { error.textContent = `Almeno ${vault.minLength} caratteri`; return; }
        if (pwd !== $(ctx.root, 'gate-confirm').value) { error.textContent = 'Le due password non coincidono'; return; }
      }
      const submit = $(ctx.root, 'gate-submit');
      submit.disabled = true;
      try {
        await ctx.api.post(vault.state === 'uninitialized' ? '/vault/init' : '/vault/unlock', { password: pwd });
        $(ctx.root, 'gate-password').value = '';
        $(ctx.root, 'gate-confirm').value = '';
        await loadVault();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    }

    // Menu del vault: blocca, cambia password, timeout
    function vaultMenu() {
      openModal('Master password', `
        <div class="form-row"><label>Password attuale</label><input class="form-input" type="password" id="f_vault_old" autocomplete="off"></div>
        <div class="form-row"><label>Nuova password (almeno ${esc(vault.minLength)} caratteri)</label><input class="form-input" type="password" id="f_vault_new" autocomplete="off"></div>
        <div class="form-row"><label>Ripeti la nuova password</label><input class="form-input" type="password" id="f_vault_new2" autocomplete="off"></div>
        <div class="form-row"><label>Blocco automatico dopo (minuti di inattività)</label><input class="form-input" type="number" min="1" max="1440" id="f_vault_minutes" value="${esc(vault.lockAfterMinutes)}"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button>
         <button class="btn btn-ghost" onclick="Ext['db-client'].lock()">🔒 Blocca ora</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveVault()">Salva</button>`);
    }

    async function saveVault() {
      const val = id => document.getElementById(id)?.value || '';
      try {
        const minutes = Number(val('f_vault_minutes'));
        if (minutes !== vault.lockAfterMinutes) await ctx.api.post('/vault/settings', { lockAfterMinutes: minutes });
        if (val('f_vault_new')) {
          if (val('f_vault_new') !== val('f_vault_new2')) { toast('Le nuove password non coincidono', 'error'); return; }
          const r = await ctx.api.post('/vault/change', { oldPassword: val('f_vault_old'), newPassword: val('f_vault_new') });
          toast(`Master password cambiata (${r.reencrypted} password ri-cifrate)`, 'success');
        } else {
          toast('Impostazioni salvate', 'success');
        }
        closeModal();
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function lock() {
      closeModal();
      await ctx.api.post('/vault/lock').catch(() => {});
      await loadVault();
    }

    async function resetVault() {
      if (prompt('Le password salvate verranno cancellate (le connessioni restano). Scrivi RESET per confermare:') !== 'RESET') return;
      try {
        await ctx.api.post('/vault/reset', { confirm: 'RESET' });
        toast('Master password azzerata: creane una nuova', 'success');
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    $(ctx.root, 'gate-form').addEventListener('submit', submitGate);
    ctx.root.addEventListener('click', e => { if (e.target.closest('[data-action="vault-reset"]')) resetVault(); });
    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="vault-menu"]')) vaultMenu(); });
    ctx.expose({ lock, saveVault });

    this.show = loadVault;
    this.refresh = loadVault;
  },
};
