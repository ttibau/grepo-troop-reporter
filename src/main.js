(function () {
    'use strict';

    /*** CONFIG ***/
    const GIST_PAGE_URL = 'https://gist.github.com/ttibau/1ceeef7a3a815aeb0cbe3ca0665c6cd5';
    const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;      // coleta a cada 6h
    const ENDPOINT_REFRESH_MS = 60 * 60 * 1000;       // checa Gist a cada 1h
    const GAME_READY_TIMEOUT_MS = 45 * 1000;          // espera menu principal
    const PANEL_START_POS = { right: 12, bottom: 72 };
    const TOGGLE_START_POS = { right: 12, bottom: 12 };
    const HERO_TOKENS = new Set(['andromeda', 'christopholus']);
  
    // Retry
    const RETRY_MAX_ATTEMPTS = 3;
    const RETRY_BASE_DELAY_MS = 1500;
    const RETRY_JITTER_MS = 400;
  
    // Cooldown do "Enviar agora"
    const SEND_NOW_COOLDOWN_MS = 30 * 1000;
  
    /*** STATE ***/
    let endpointURL = null;
    let gistVersionRemote = null;
    let gistNotesRemote = null;
  
    let panelEl = null;
    let toggleBtn = null;
    let toggleBadge = null;
  
    let countdownTimer = null;
    let autosendTimer = null;
    let endpointTimer = null;
  
    let nextRunAt = Date.now() + AUTO_INTERVAL_MS;
    let sending = false;
    let gameReady = false;
    let openingOverview = false;
    let overviewOpenedByScript = false;
    let sendNowCooldownUntil = 0;
  
    /*** STORAGE KEYS ***/
    function lastSentKey(world)   { return `last_sent_${world || 'unknown'}`; }
    function historyKey(world)    { return `send_history_${world || 'unknown'}`; }
    function allianceCacheKey(w)  { return `alli_name_${w || 'unknown'}`; }
    const GIST_VER_KEY = 'gist_version_local';
    const GIST_URL_KEY = 'gist_endpoint_url';
    const TOGGLE_POS_KEY = 'toggle_pos';
    const PANEL_POS_KEY  = 'panel_pos';
  
    /*** UTILS ***/
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const getSavedPos = (key, fallback) => {
      try {
        const raw = GM_getValue(key, null);
        if (!raw) return { ...fallback };
        const p = JSON.parse(raw);
        if (typeof p?.right === 'number' && typeof p?.bottom === 'number') return p;
        return { ...fallback };
      } catch { return { ...fallback }; }
    };
  
    function nowISO() { return new Date().toISOString(); }
    function msSince(ts) { return Date.now() - (ts || 0); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function retryDelay(a){ return RETRY_BASE_DELAY_MS*Math.pow(1.5,a-1) + Math.floor(Math.random()*RETRY_JITTER_MS); }
    function setStatus(msg){ const el = document.querySelector('#gp-status'); if (el) el.textContent = msg; }
  
    function setCountdownLabel() {
      const lbl = document.querySelector('#gp-countdown');
      if (!lbl) return;
      const ms = Math.max(0, nextRunAt - Date.now());
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      lbl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
  
    function addHistory(world, success, cityCount, note='') {
      const key = historyKey(world);
      let arr = [];
      try { arr = JSON.parse(GM_getValue(key, '[]')); } catch {}
      arr.unshift({ ts: new Date().toLocaleString(), success, cityCount, note });
      arr = arr.slice(0, 5);
      GM_setValue(key, JSON.stringify(arr));
      renderHistory(arr);
    }
    function renderHistory(arr) {
      const box = document.querySelector('#gp-history');
      if (!box) return;
      if (!arr || !arr.length) { box.innerHTML = '<em>Sem histórico ainda.</em>'; return; }
      box.innerHTML = arr.map(item => {
        const mark = item.success ? '✅' : '❌';
        return `<div style="display:flex;justify-content:space-between;gap:8px;">
          <span>${mark} ${item.ts}</span>
          <span>${item.cityCount ?? '-'} cidades</span>
        </div>`;
      }).join('');
    }
  
    /*** AUDIO (beep curto) ***/
    function beepOk() { try { beep(880, 120); } catch {} }
    function beepErr() { try { beep(220, 180); } catch {} }
    function beep(freq = 440, dur = 150) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur/1000);
      setTimeout(() => { o.stop(); ctx.close(); }, dur + 50);
    }
  
    /*** HELPERS DOM ***/
    function fireMouse(el, type) {
      if (!el) return false;
      try {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true,
          view: (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window)
        }));
        return true;
      } catch {
        try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); return true; }
        catch {
          try { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); return true; }
          catch {
            if (type === 'click' && typeof el.click === 'function') { el.click(); return true; }
            return false;
          }
        }
      }
    }
  
    async function waitForGameReady(timeoutMs = GAME_READY_TIMEOUT_MS) {
      const sel = '.content > ul > li.main_menu_item';
      const start = Date.now();
      if (document.querySelector(sel)) return true;
      return new Promise((resolve) => {
        const mo = new MutationObserver(() => {
          if (document.querySelector(sel)) { mo.disconnect(); resolve(true); }
        });
        mo.observe(document.body, { childList: true, subtree: true });
        const iv = setInterval(() => {
          if (document.querySelector(sel)) { clearInterval(iv); mo.disconnect(); resolve(true); }
          else if (Date.now() - start > timeoutMs) { clearInterval(iv); mo.disconnect(); resolve(false); }
        }, 300);
      });
    }
  
    /*** ENV (sync) ***/
    function getEnvSync() {
      const host = location.host;
      const world = host.split('.')[0] || '';
      const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
      let player = (uw.Game && uw.Game.player_name) || '';
      let alliance = (uw.Game && uw.Game.alliance_name) || '';
      if (!player) {
        player =
          document.querySelector('#ui_box .player_name, .ui_info .player_name, .player_name')?.textContent?.trim() ||
          document.querySelector('.ui_various .player, .gp_player_name')?.textContent?.trim() || '';
      }
      if (!alliance) {
        alliance =
          document.querySelector('.alliance_name, .ui_info .alliance, .gp_alliance_name')?.textContent?.trim() || '';
      }
      return { world, player, alliance };
    }
  
    function updateEnvPanel(envOpt) {
      const env = envOpt || getEnvSync();
      const world = env.world;
      const last = Number(GM_getValue(lastSentKey(world), 0));
      const alli = env.alliance || GM_getValue(allianceCacheKey(world), '—');
      const html = `
        <div><b>Mundo:</b> ${world || '—'}</div>
        <div><b>Jogador:</b> ${env.player || '—'}</div>
        <div><b>Aliança:</b> ${alli}</div>
        <div><b>Último envio:</b> ${last ? Math.floor(msSince(last)/60000)+' min atrás' : '—'}</div>
      `;
      const box = document.querySelector('#gp-env');
      if (box) box.innerHTML = html;
    }
  
    /*** ENV (async) — preenche aliança se vazia ***/
    async function getEnvAsync() {
      const env = getEnvSync();
      if (env.alliance) { updateEnvPanel(env); return env; }
  
      const cached = GM_getValue(allianceCacheKey(env.world), '');
      if (cached) { env.alliance = cached; updateEnvPanel(env); return env; }
  
      await waitForGameReady();
      const liAlliance = document.querySelector('li.alliance.main_menu_item');
      if (liAlliance) {
        const btn = liAlliance.querySelector('.button') || liAlliance;
        if (btn) { (typeof btn.click === 'function') ? btn.click() : fireMouse(btn, 'click'); }
        await sleep(250);
  
        const propLink = document.querySelector('#alliance-properties');
        if (propLink) { (typeof propLink.click === 'function') ? propLink.click() : fireMouse(propLink, 'click'); }
  
        const name = await readAllianceNameFromDialog(7000);
        if (name) {
          env.alliance = name;
          GM_setValue(allianceCacheKey(env.world), name);
          updateEnvPanel(env);
        }
        closeDialogContaining('.settings_column');
      }
      return env;
    }
  
    async function readAllianceNameFromDialog(timeoutMs = 7000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const fieldsets = document.querySelectorAll('.settings_column fieldset');
        for (const fs of fieldsets) {
          const leg = fs.querySelector('legend b');
          if (leg && leg.textContent.trim().toLowerCase() === 'nome') {
            const p = fs.querySelector('p');
            const txt = p?.textContent?.trim();
            if (txt) return txt;
          }
        }
        await sleep(200);
      }
      return '';
    }
  
    function closeDialogContaining(innerSelector) {
      const inner = document.querySelector(innerSelector);
      if (!inner) return false;
      let node = inner;
      while (node && node !== document.body) {
        if (node.classList && node.classList.contains('ui-dialog')) {
          const btn = node.querySelector('button.ui-dialog-titlebar-close');
          if (btn) { (typeof btn.click === 'function') ? btn.click() : fireMouse(btn,'click'); return true; }
          break;
        }
        node = node.parentNode;
      }
      return closeTopVisibleDialog();
    }
    function closeTopVisibleDialog() {
      const btns = Array.from(document.querySelectorAll('button.ui-dialog-titlebar-close'));
      for (let i = btns.length - 1; i >= 0; i--) {
        const b = btns[i];
        const st = getComputedStyle(b);
        const visible = b.offsetParent !== null && st.display !== 'none' && st.visibility !== 'hidden';
        if (visible) { (typeof b.click === 'function') ? b.click() : fireMouse(b,'click'); return true; }
      }
      return false;
    }
  
    /*** GIST → endpoint + version ***/
    async function refreshFromGistJSON() {
      setStatus('Checando atualização…');
      const rawUrl = await resolveGistRawUrl(GIST_PAGE_URL);
      const text = await gmGetText(rawUrl);
  
      let remote = null;
      try { remote = JSON.parse(text); }
      catch {
        remote = { endpoint: (text || '').trim(), version: null };
      }
      const url = remote.endpoint;
      const ver = remote.version || null;
      const notes = remote.notes || null;
  
      if (!url || !/^https?:\/\/.+\/exec/.test(url)) throw new Error('Gist sem endpoint válido (/exec).');
  
      endpointURL = url;
      gistVersionRemote = ver;
      gistNotesRemote = notes;
      GM_setValue(GIST_URL_KEY, endpointURL);
  
      const localVer = GM_getValue(GIST_VER_KEY, null);
      const hasUpdate = !!(ver && localVer && ver !== localVer);
  
      applyUpdateUI(hasUpdate, ver, notes);
      setStatus('Endpoint OK.' + (hasUpdate ? ' (nova versão disponível)' : ''));
    }
  
    function applyUpdateUI(hasUpdate, ver, notes) {
      if (!toggleBtn) return;
  
      // cria/atualiza badge UPDATE que segue o botão
      if (!toggleBadge) {
        toggleBadge = document.createElement('div');
        Object.assign(toggleBadge.style, {
          position: 'fixed',
          zIndex: 1000000,
          background: '#ef4444',
          color: '#fff',
          borderRadius: '10px',
          padding: '2px 6px',
          fontSize: '10px',
          fontWeight: '700',
          display: 'none',
          boxShadow: '0 4px 10px rgba(0,0,0,0.35)',
          cursor: 'pointer',
          userSelect: 'none'
        });
        toggleBadge.textContent = 'UPDATE';
        toggleBadge.title = 'Nova versão disponível — clique para recarregar';
        toggleBadge.onclick = () => { location.reload(); };
        document.body.appendChild(toggleBadge);
      }
      toggleBadge.style.display = hasUpdate ? 'block' : 'none';
      positionBadgeNearToggle();
  
      // Botão dentro do painel
      const existing = document.querySelector('#gp-update-btn');
      if (existing) existing.remove();
  
      if (panelEl) {
        const btn = document.createElement('button');
        btn.id = 'gp-update-btn';
        btn.textContent = hasUpdate ? `Atualização disponível — Recarregar` : `Versão atual`;
        Object.assign(btn.style, {
          width: '100%', padding: '8px', border: '0', borderRadius: '8px',
          background: hasUpdate ? '#ef4444' : '#374151',
          color: '#fff', fontWeight: 700, cursor: hasUpdate ? 'pointer' : 'default',
          marginTop: '8px'
        });
        btn.title = notes ? String(notes) : (hasUpdate ? 'Clique para atualizar' : 'Você já está na última versão');
        btn.disabled = !hasUpdate;
        btn.onclick = () => { if (hasUpdate) location.reload(); };
  
        const content = panelEl.querySelector('div[style*="padding:10px"]') || panelEl;
        content.appendChild(btn);
      }

      updateVersionPill();
    }

    function updateVersionPill() {
        const pill = document.querySelector('#gp-ver');
        if (!pill) return;
        if (gistVersionRemote) {
          pill.textContent = `v${gistVersionRemote}`;
          pill.style.display = 'inline-block';
        } else {
          pill.style.display = 'none';
        }
      }
  
    function positionBadgeNearToggle() {
      if (!toggleBtn || !toggleBadge) return;
      const r = parseInt(toggleBtn.style.right || TOGGLE_START_POS.right, 10);
      const b = parseInt(toggleBtn.style.bottom || TOGGLE_START_POS.bottom, 10);
      toggleBadge.style.right  = (r + 34) + 'px';
      toggleBadge.style.bottom = (b + 34) + 'px';
    }
  
    function resolveGistRawUrl(pageUrl) {
      if (/gist\.githubusercontent\.com|raw\.githubusercontent\.com/.test(pageUrl)) return Promise.resolve(pageUrl);
      const m = pageUrl.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/i);
      if (m) return Promise.resolve(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`);
      return gmGetText(pageUrl).then(html => {
        const match = html.match(/href="(https:\/\/gist\.githubusercontent\.com\/[^"]+\/raw[^"]*)"/i);
        if (match) return match[1];
        throw new Error('Não consegui resolver a URL RAW do Gist.');
      });
    }
    function gmGetText(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, headers: { 'Accept': '*/*' },
          onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText) : reject(new Error('HTTP ' + res.status)),
          onerror: reject
        });
      });
    }
  
    /*** COLETA ***/
    async function scrapeAllCities() {
      const env = await getEnvAsync();
      const cities = [];
      const lis = document.querySelectorAll('li.unit_town.town_item');
      lis.forEach(li => {
        const idAttr = (li.id || '').replace('ov_town_', '');
        const dataTownId = li.querySelector('[data-town-id]')?.getAttribute('data-town-id');
        const cityId = dataTownId || idAttr || null;
        const cityName = li.querySelector('.gp_town_link')?.textContent?.trim() || '';
        const unitsBlock = li.querySelector('.current_units');
        const { units, heroes } = parseUnitsFromContainer(unitsBlock);
        if (Object.keys(units).length || Object.keys(heroes).length) {
          cities.push({ id: cityId, name: cityName, units, heroes });
        }
      });
      return { timestamp: nowISO(), ...env, cities };
    }
  
    function parseUnitsFromContainer(container) {
      const units = {}, heroes = {};
      if (!container) return { units, heroes };
      container.querySelectorAll('.place_unit').forEach(div => {
        const qtySpan = div.querySelector('.place_unit_white, .place_unit_black, .place_unit_hero');
        const qty = parseInt((qtySpan?.textContent || '0').replace(/\D+/g, ''), 10) || 0;
        const cls = Array.from(div.classList);
        let token = cls.find(c => c.startsWith('unit_') && c !== 'unit_icon25x25');
        if (!token) return;
        token = token.replace(/^unit_/, '');
        const isHero = !!div.querySelector('.place_unit_hero') || HERO_TOKENS.has(token);
        if (qty > 0) { (isHero ? heroes : units)[token] = ((isHero ? heroes : units)[token] || 0) + qty; }
      });
      return { units, heroes };
    }
  
    /*** ENVIO ***/
    function send(endpoint, payload) {
      const body = JSON.stringify(payload);
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url: endpoint, headers: { 'Content-Type': 'application/json' }, data: body,
          onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
          onerror: reject
        });
      });
    }
  
    /*** VISÃO GERAL ***/
    function openTroopOverviewOnce() {
      if (openingOverview) return;
      openingOverview = true;
  
      const premiumBtn = document.querySelector('.toolbar_button.premium');
      if (premiumBtn) { fireMouse(premiumBtn, 'mouseover'); }
  
      setTimeout(() => {
        const item = document.querySelector('li.unit_overview a[name="unit_overview"]');
        if (item) {
          overviewOpenedByScript = true;
          (typeof item.click === 'function') ? item.click() : fireMouse(item, 'click');
        }
        setTimeout(() => { openingOverview = false; }, 1200);
      }, 300);
    }
    function isTroopOverviewLoaded() {
      return !!document.querySelector('li.unit_town.town_item .current_units');
    }
    function closeTroopOverviewIfWeOpened() {
      if (!overviewOpenedByScript) return;
      closeTopVisibleDialog();
      overviewOpenedByScript = false;
    }
  
    /*** AUTO + RETRY ***/
    async function sendWithRetry(triggerLabel) {
      if (!endpointURL) await refreshFromGistJSON();
      if (!gameReady) { setStatus('Aguardando jogo carregar…'); gameReady = await waitForGameReady(); }
  
      openTroopOverviewOnce();
  
      let attempt = 0;
      let lastErr = null;
  
      while (attempt < RETRY_MAX_ATTEMPTS) {
        attempt++;
        try {
          if (!isTroopOverviewLoaded()) {
            setStatus(`(${attempt}/${RETRY_MAX_ATTEMPTS}) Aguardando visão de tropas…`);
            await sleep(retryDelay(attempt));
            continue;
          }
  
          setStatus(`(${attempt}/${RETRY_MAX_ATTEMPTS}) Coletando tropas…`);
          const payload = await scrapeAllCities();
  
          if (payload.cities.length === 0 && attempt < RETRY_MAX_ATTEMPTS) {
            setStatus(`(${attempt}/${RETRY_MAX_ATTEMPTS}) Nenhuma tropa encontrada ainda. Tentando novamente…`);
            await sleep(retryDelay(attempt));
            continue;
          }
          if (payload.cities.length === 0) setStatus('Nenhuma tropa encontrada. Enviando 0 cidades…');
  
          setStatus(`(${attempt}/${RETRY_MAX_ATTEMPTS}) Enviando ${payload.cities.length} cidades…`);
          await send(endpointURL, payload);
  
          if (gistVersionRemote) GM_setValue(GIST_VER_KEY, gistVersionRemote);
  
          const env = getEnvSync();
          GM_setValue(lastSentKey(env.world), Date.now());
          addHistory(env.world, true, payload.cities.length);
          setStatus('Enviado com sucesso!');
          beepOk();
          closeTroopOverviewIfWeOpened();
          return;
        } catch (e) {
          lastErr = e;
          setStatus(`Falha (tentativa ${attempt}). Retentando…`);
          await sleep(retryDelay(attempt));
        }
      }
      const env = getEnvSync();
      addHistory(env.world, false, 0, lastErr ? lastErr.message : '');
      setStatus('Falha após múltiplas tentativas' + (lastErr ? `: ${lastErr.message}` : ''));
      beepErr();
    }
  
    function scheduleAuto() {
      if (autosendTimer) clearInterval(autosendTimer);
      if (countdownTimer) clearInterval(countdownTimer);
      if (endpointTimer) clearInterval(endpointTimer);
  
      const env = getEnvSync();
      const last = Number(GM_getValue(lastSentKey(env.world), 0));
      const elapsed = msSince(last);
      nextRunAt = Date.now() + Math.max(0, AUTO_INTERVAL_MS - elapsed);
  
      countdownTimer = setInterval(setCountdownLabel, 1000);
      setCountdownLabel();
  
      autosendTimer = setInterval(async () => {
        if (!gameReady) return;
        if (Date.now() >= nextRunAt && !sending) {
          sending = true;
          try { await sendWithRetry('auto'); }
          finally {
            sending = false;
            nextRunAt = Date.now() + AUTO_INTERVAL_MS;
            setCountdownLabel();
          }
        }
      }, 1000);
  
      const doRefresh = async () => {
        try { await refreshFromGistJSON(); } catch (e) { setStatus('Falha ao atualizar endpoint: ' + e.message); }
      };
      doRefresh();
      endpointTimer = setInterval(doRefresh, ENDPOINT_REFRESH_MS);
  
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && Date.now() >= nextRunAt && !sending) {
          sending = true;
          sendWithRetry('visible').finally(() => {
            sending = false;
            nextRunAt = Date.now() + AUTO_INTERVAL_MS;
            setCountdownLabel();
          });
        }
      });
    }
  
    /*** UI ***/
    function createToggleButton() {
        console.log('[Grepolis Reporter] createToggleButton chamada');
        if (toggleBtn) {
        console.log('[Grepolis Reporter] Toggle button já existe, retornando');
        return;
        }
  
        // restaura posição salva (fallback: bottom/right 12px)
        let savedPos = null;
        try {
        savedPos = JSON.parse(GM_getValue('gp_toggle_pos', '{"right":12,"bottom":12}'));
        } catch (e) {
        savedPos = { right: 12, bottom: 12 };
        }
        if (typeof savedPos?.right !== 'number' || typeof savedPos?.bottom !== 'number') {
        savedPos = { right: 12, bottom: 12 };
        }
    
        const btn = document.createElement('button');
        btn.id = 'gp-toggle';
        Object.assign(btn.style, {
        position: 'fixed',
        right: savedPos.right + 'px',
        bottom: savedPos.bottom + 'px',
        zIndex: '999999',
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        border: '0',
        background: '#8a2be2',
        color: '#fff',
        cursor: 'pointer',
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        fontSize: '20px',
        userSelect: 'none'
        });
        btn.title = 'Abrir painel Grepolis';
        btn.textContent = '🐲';
  
        // Clique: abre/fecha painel
        btn.addEventListener('click', () => {
            if (panelEl && panelEl.style.display !== 'none') {
                panelEl.style.display = 'none';
                btn.title = 'Abrir painel Grepolis';
            } else {
                createPanel();
                panelEl.style.display = 'block';
                btn.title = 'Fechar painel Grepolis';
            }
        });
  
        // Adiciona no DOM (ATENÇÃO: passamos o ELEMENTO, não a função)
        document.body.appendChild(btn);
  
        // Torna arrastável e persiste posição
        attachDragToToggle(btn);
  
        // guarda na variável global usada pelo restante do script
        toggleBtn = btn;
        console.log('[Grepolis Reporter] Toggle button criado com sucesso');
    }
    
   function attachDragToToggle(btn) {
    let dragging = false;
    let startX = 0, startY = 0;
    let startRight = 0, startBottom = 0;
    let moved = false;
  
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
  
      const maxRight = window.innerWidth - 60;
      const maxBottom = window.innerHeight - 60;
  
      const newRight = clamp(startRight - dx, 0, maxRight);
      const newBottom = clamp(startBottom - dy, 0, maxBottom);
  
      btn.style.right = `${newRight}px`;
      btn.style.bottom = `${newBottom}px`;
    };
  
    const onUp = (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!dragging) return;
      dragging = false;
  
      // salva posição
      const right = parseInt(btn.style.right, 10) || 12;
      const bottom = parseInt(btn.style.bottom, 10) || 12;
      GM_setValue('gp_toggle_pos', JSON.stringify({ right, bottom }));
  
      // se houve arrasto, suprime o clique “fantasma”
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    };
  
    btn.addEventListener('mousedown', (e) => {
      // só inicia arrasto com botão esquerdo
      if (e.button !== 0) return;
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      startRight = parseInt(btn.style.right, 10) || 12;
      startBottom = parseInt(btn.style.bottom, 10) || 12;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }
    
      function onMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newRight = clamp(startRight - dx, 0, window.innerWidth - 60);
        let newBottom = clamp(startBottom - dy, 0, window.innerHeight - 60);
        btn.style.right = `${newRight}px`;
        btn.style.bottom = `${newBottom}px`;
        positionBadgeNearToggle();
      }
      function onUp(e) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!dragging) return;
        dragging = false;
        commit();
  
        if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
          // arrasto: evita que o mouseup dispare o clique (abrir/fechar)
          e.stopPropagation();
        }
      }
    
  
      function createPanel() {
        if (panelEl) return;
      
        panelEl = document.createElement('div');
        panelEl.id = 'gp-ally-panel';
      
        const savedPos = getSavedPos(PANEL_POS_KEY, PANEL_START_POS);
      
        Object.assign(panelEl.style, {
          position:'fixed',
          right: `${savedPos.right}px`,
          bottom: `${savedPos.bottom}px`,
          zIndex: 999998,
          background:'rgba(20,22,28,0.97)',
          color:'#e5e7eb',
          padding:'0',
          border:'1px solid #2a2f3a',
          borderRadius:'14px',
          width:'360px',
          fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
          boxShadow:'0 10px 28px rgba(0,0,0,0.45)',
          backdropFilter: 'blur(2px)'
        });
      
        // header com botão de minimizar posicionado no canto direito
        panelEl.innerHTML = `
          <div id="gp-header" style="
            position:relative; display:flex; align-items:center; gap:10px;
            padding:12px 44px 12px 14px; border-bottom:1px solid #2a2f3a;
            border-top-left-radius:14px; border-top-right-radius:14px; background:#141820; cursor:move;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:18px;line-height:1">🐲</span>
              <div style="display:flex;flex-direction:column;gap:2px;">
                <strong style="font-size:14px;color:#fff;letter-spacing:.2px">Tropas da Aliança</strong>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span id="gp-ver" style="
                    display:none; padding:2px 8px; border-radius:999px;
                    font-size:10px; font-weight:700; background:#1f2937; color:#9ca3af;">v—</span>
                  <span style="font-size:11px;color:#9ca3af;">Snapshot a cada 6h</span>
                </div>
              </div>
            </div>
      
            <button id="gp-hide" title="Recolher" aria-label="Recolher painel" style="
              position:absolute; top:8px; right:8px;
              width:28px; height:28px; border:none; border-radius:8px;
              background:#1f2430; color:#cbd5e1; cursor:pointer; display:grid; place-items:center;">
              <span style="font-size:16px; line-height:1">×</span>
            </button>
          </div>
      
          <div style="padding:12px 14px 14px;">
            <div id="gp-env" style="font-size:12px;opacity:.95;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;"></div>
      
            <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 10px;font-size:12px;">
              <span style="opacity:.9">Próxima coleta:</span>
              <span id="gp-countdown" style="font-weight:800;color:#f8fafc;background:#0f172a;padding:4px 8px;border-radius:8px;min-width:86px;text-align:center">--:--:--</span>
            </div>
      
            <div style="margin:8px 0 12px;">
              <button id="gp-send-now" style="
                width:100%;padding:10px 12px;border:0;border-radius:10px;
                background:#10b981;color:#06281f;font-weight:800;cursor:pointer;letter-spacing:.2px;box-shadow:0 6px 14px rgba(16,185,129,.25);">
                Enviar agora
              </button>
            </div>
      
            <div id="gp-status" style="font-size:12px;min-height:16px;opacity:.95;margin-bottom:10px;"></div>
      
            <details id="gp-history-box" style="background:#0f1117;border:1px solid #2a2f3a;border-radius:10px;padding:8px;">
              <summary style="cursor:pointer;color:#e5e7eb;user-select:none;">Histórico (últimos 5 envios)</summary>
              <div id="gp-history" style="margin-top:6px;font-size:12px;display:flex;flex-direction:column;gap:4px;"></div>
            </details>
      
            <div style="font-size:11px;opacity:.8;margin-top:10px;line-height:1.35;">
              Dúvidas, sugestões? Chama um líder.
            </div>
          </div>
        `;
        document.body.appendChild(panelEl);
      
        updateEnvPanel();
        try { renderHistory(JSON.parse(GM_getValue(historyKey(getEnvSync().world), '[]'))); } catch {}
      
        // drag do painel pelo cabeçalho
        makeDraggable(panelEl, panelEl.querySelector('#gp-header'), PANEL_POS_KEY);
      
        // close
        panelEl.querySelector('#gp-hide').onclick = (e) => {
          e.stopPropagation();
          panelEl.style.display = 'none';
          if (toggleBtn) toggleBtn.title = 'Abrir painel Grepolis';
        };
      
        // botão "Enviar agora" + cooldown
        const sendNowBtn = panelEl.querySelector('#gp-send-now');
        const updateSendNowState = () => {
          const remain = sendNowCooldownUntil - Date.now();
          if (sending) {
            sendNowBtn.disabled = true;
            sendNowBtn.textContent = 'Enviando…';
          } else if (remain > 0) {
            sendNowBtn.disabled = true;
            const s = Math.ceil(remain/1000);
            sendNowBtn.textContent = `Aguarde ${s}s`;
          } else {
            sendNowBtn.disabled = false;
            sendNowBtn.textContent = 'Enviar agora';
          }
        };
        sendNowBtn.onclick = async () => {
          if (sending) return;
          const remain = sendNowCooldownUntil - Date.now();
          if (remain > 0) return;
      
          sending = true;
          sendNowCooldownUntil = Date.now() + SEND_NOW_COOLDOWN_MS;
          updateSendNowState();
          setStatus('Envio manual iniciado…');
      
          try { await sendWithRetry('manual'); }
          finally {
            sending = false;
            nextRunAt = Date.now() + AUTO_INTERVAL_MS;
            setCountdownLabel();
      
            const cdIv = setInterval(() => {
              updateSendNowState();
              if (Date.now() >= sendNowCooldownUntil) {
                clearInterval(cdIv);
                updateSendNowState();
              }
            }, 250);
          }
        };
      
        setInterval(updateSendNowState, 500);
        updateSendNowState();
      
        // se já temos versão remota, mostra a pill
        updateVersionPill();
      }
  
    function makeDraggable(panel, handle, storageKey) {
      let dragging = false;
      let startX = 0, startY = 0;
      let startRight = 0, startBottom = 0;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        startRight = parseInt(panel.style.right, 10) || (window.innerWidth - rect.right);
        startBottom = parseInt(panel.style.bottom, 10) || (window.innerHeight - rect.bottom);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
      function onMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newRight = clamp(startRight - dx, 0, window.innerWidth - 60);
        let newBottom = clamp(startBottom - dy, 0, window.innerHeight - 60);
        panel.style.right = `${newRight}px`;
        panel.style.bottom = `${newBottom}px`;
      }
      function onUp() {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (storageKey) {
          const pos = { right: parseInt(panel.style.right, 10) || 0,
                        bottom: parseInt(panel.style.bottom, 10) || 0 };
          GM_setValue(storageKey, JSON.stringify(pos));
        }
      }
    }
  
    /*** BOOT ***/
    async function init() {
      console.log('[Grepolis Reporter] Iniciando script...');
      
      try {
        console.log('[Grepolis Reporter] Criando toggle button...');
        createToggleButton();   // cria e garante que o ícone esteja presente/visível
        
        console.log('[Grepolis Reporter] Criando painel...');
        createPanel();          // cria painel (pode ser escondido depois)

        console.log('[Grepolis Reporter] Aguardando jogo ficar pronto...');
        gameReady = await waitForGameReady();
        setStatus(gameReady ? 'Jogo pronto.' : 'Não detectei o menu principal, mas vou tentar continuar.');

        console.log('[Grepolis Reporter] Agendando execução automática...');
        scheduleAuto();         // timers e polling (funciona com painel aberto ou fechado)
        
        // Verifica se há atualizações disponíveis
        if (gistVersionRemote) {
          const hasUpdate = GM_getValue(GIST_VER_KEY, null) && GM_getValue(GIST_VER_KEY) !== gistVersionRemote;
          applyUpdateUI(hasUpdate, gistVersionRemote, gistNotesRemote);
        }
        
        console.log('[Grepolis Reporter] Script inicializado com sucesso!');
      } catch (error) {
        console.error('[Grepolis Reporter] Erro durante inicialização:', error);
        setStatus('Erro durante inicialização: ' + error.message);
      }
    }
  
    console.log('[Grepolis Reporter] Script carregado, readyState:', document.readyState);
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      console.log('[Grepolis Reporter] DOM pronto, executando init()');
      init();
    } else {
      console.log('[Grepolis Reporter] Aguardando DOMContentLoaded...');
      document.addEventListener('DOMContentLoaded', () => {
        console.log('[Grepolis Reporter] DOMContentLoaded disparado, executando init()');
        init();
      });
    }
})();