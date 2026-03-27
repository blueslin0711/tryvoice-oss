/**
 * First-run setup wizard — shown when /health returns setupNeeded: true.
 * Dynamically fetches adapter schemas from the backend and renders
 * a configuration form for the selected adapter.
 *
 * After setup, if the adapter supports discovery, shows discovered bots
 * before reloading the page.
 */

interface SchemaField {
  name: string;
  label: string;
  fieldType: string;
  required: boolean;
  default: string | null;
  description: string;
  options: string[] | null;
  group: string;
}

interface AdapterCapabilities {
  supportsDiscovery?: boolean;
  supportsCreation?: boolean;
  supportsStream?: boolean;
  supportsSessionResume?: boolean;
}

interface CreateBotSchemaField {
  name: string;
  label: string;
  fieldType: string;
  required: boolean;
  default: string | null;
  description: string;
  options: string[] | null;
}

interface AdapterInfo {
  schema: SchemaField[];
  capabilities?: AdapterCapabilities;
  createBotSchema?: CreateBotSchemaField[];
}

interface AdapterSchemas {
  [adapterId: string]: AdapterInfo;
}

interface DiscoveredBot {
  botId: string;
  name: string;
  sessionKey: string;
  metadata?: Record<string, unknown>;
}

const ADAPTER_LABELS: Record<string, string> = {
  'echo': 'Demo (Echo) — no API keys needed',
  'openclaw': 'OpenClaw',
  'openai-compat': 'OpenAI-Compatible LLM',
  'anthropic': 'Anthropic Claude (Cloud API)',
  'claude-code': 'Claude Code',
};

const INPUT_STYLE = 'width:100%;padding:10px;background:#0d1520;color:#e0e8f0;border:1px solid #2a3a4a;border-radius:8px;font-size:14px;box-sizing:border-box;';
const LABEL_STYLE = 'display:block;margin-bottom:6px;font-size:13px;color:#8899aa;';
const GROUP_ORDER = ['connection', 'model', 'advanced'];

export async function checkAndShowSetupWizard(): Promise<boolean> {
  try {
    const resp = await fetch('/health');
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.setupNeeded) return false;

    // Fetch adapter schemas before showing wizard
    let adapters: AdapterSchemas = {};
    try {
      const schemaResp = await fetch('/setup/adapter-schemas');
      if (schemaResp.ok) {
        const schemaData = await schemaResp.json();
        adapters = schemaData.adapters || {};
      }
    } catch (_e) { /* proceed with empty schemas */ }

    showSetupWizard(adapters, true, new Set());
    return true;
  } catch (_e) {
    return false;
  }
}

/** Open the wizard manually (e.g. from settings panel for reconfiguration). */
export async function openSetupWizard(): Promise<void> {
  // Remove existing overlay if any
  document.getElementById('setup-wizard-overlay')?.remove();
  let adapters: AdapterSchemas = {};
  let existingSlotIds: Set<string> = new Set();
  try {
    const [schemaResp, slotsResp] = await Promise.all([
      fetch('/setup/adapter-schemas'),
      fetch('/slots'),
    ]);
    if (schemaResp.ok) {
      const data = await schemaResp.json();
      adapters = data.adapters || {};
    }
    if (slotsResp.ok) {
      const slotsData = await slotsResp.json();
      const slots = Array.isArray(slotsData?.slots) ? slotsData.slots : [];
      existingSlotIds = new Set(slots.map((s: {slotId?: string}) => s.slotId || ''));
    }
  } catch (_e) { /* proceed with empty schemas */ }
  showSetupWizard(adapters, false, existingSlotIds);
}

function showSetupWizard(adapters: AdapterSchemas, isInitialSetup = true, existingSlotIds: Set<string> = new Set()): void {
  const overlay = document.createElement('div');
  overlay.id = 'setup-wizard-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:16px;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1a2332;color:#e0e8f0;border-radius:16px;padding:32px;max-width:480px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  card.style.position = 'relative';

  // For initial setup, show API keys step first; for reconfiguration, go straight to adapter
  if (isInitialSetup) {
    _renderApiKeysStep(overlay, card, adapters, existingSlotIds);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return;
  }

  _renderAdapterStep(overlay, card, adapters, false, existingSlotIds);
}

// ── Step 1: API Keys (Groq STT + Azure TTS) ──────────────────────────────

function _renderApiKeysStep(
  overlay: HTMLElement,
  card: HTMLElement,
  adapters: AdapterSchemas,
  existingSlotIds: Set<string>,
): void {
  const _LABEL = 'display:block;color:#8899aa;font-size:12px;margin-bottom:4px;';
  const _INPUT = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid #2a3a4a;background:#0d1520;color:#e0e8f0;font-size:13px;box-sizing:border-box;';

  card.innerHTML = `
    <h2 style="margin:0 0 8px;font-size:22px;">TryVoice Setup</h2>
    <p style="margin:0 0 4px;color:#8899aa;font-size:14px;">Step 1 of 2 — API Keys</p>
    <p style="margin:0 0 24px;color:#667788;font-size:12px;">
      Optional but recommended for lower latency and higher quality voice.
    </p>

    <div style="margin-bottom:20px;">
      <label style="${_LABEL}">Groq API Key <span style="color:#667788;font-size:11px;">(faster speech-to-text)</span></label>
      <p style="color:#667788;font-size:11px;margin:0 0 6px;">
        Get a free key at <a href="https://console.groq.com" target="_blank" rel="noopener"
          style="color:#1f86ff;text-decoration:underline;">console.groq.com</a>
      </p>
      <div style="display:flex;gap:8px;">
        <input id="sw-groq-key" type="password" placeholder="gsk_..."
          style="${_INPUT}flex:1;">
        <button id="sw-groq-toggle" type="button"
          style="padding:8px 12px;border:1px solid #2a3a4a;border-radius:6px;background:#0d1520;color:#8899aa;cursor:pointer;font-size:12px;white-space:nowrap;">
          Show
        </button>
      </div>
    </div>

    <div style="margin-bottom:20px;">
      <label style="${_LABEL}">Azure Speech Key <span style="color:#667788;font-size:11px;">(high-quality text-to-speech)</span></label>
      <p style="color:#667788;font-size:11px;margin:0 0 6px;">
        Get a key at <a href="https://azure.microsoft.com/en-us/products/ai-services/speech-to-text" target="_blank" rel="noopener"
          style="color:#1f86ff;text-decoration:underline;">Azure Speech Services</a>
      </p>
      <div style="display:flex;gap:8px;">
        <input id="sw-azure-key" type="password" placeholder="Azure Speech key..."
          style="${_INPUT}flex:1;">
        <button id="sw-azure-toggle" type="button"
          style="padding:8px 12px;border:1px solid #2a3a4a;border-radius:6px;background:#0d1520;color:#8899aa;cursor:pointer;font-size:12px;white-space:nowrap;">
          Show
        </button>
      </div>
      <div style="margin-top:8px;">
        <label style="${_LABEL}">Azure Region</label>
        <input id="sw-azure-region" type="text" placeholder="eastus"
          style="${_INPUT}">
      </div>
    </div>

    <div id="sw-keys-error" style="display:none;color:#eb4d4b;font-size:13px;margin-bottom:12px;"></div>

    <div style="display:flex;gap:12px;justify-content:flex-end;">
      <button id="sw-keys-skip" type="button"
        style="padding:10px 20px;border-radius:8px;border:1px solid #2a3a4a;background:transparent;color:#8899aa;cursor:pointer;font-size:14px;">
        Skip
      </button>
      <button id="sw-keys-save" type="button"
        style="padding:10px 20px;border-radius:8px;border:none;background:#1f86ff;color:#fff;cursor:pointer;font-size:14px;font-weight:600;">
        Save &amp; Continue
      </button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Show/hide toggles
  const groqInput = card.querySelector('#sw-groq-key') as HTMLInputElement;
  const azureInput = card.querySelector('#sw-azure-key') as HTMLInputElement;
  card.querySelector('#sw-groq-toggle')?.addEventListener('click', () => {
    const btn = card.querySelector('#sw-groq-toggle') as HTMLButtonElement;
    if (groqInput.type === 'password') { groqInput.type = 'text'; btn.textContent = 'Hide'; }
    else { groqInput.type = 'password'; btn.textContent = 'Show'; }
  });
  card.querySelector('#sw-azure-toggle')?.addEventListener('click', () => {
    const btn = card.querySelector('#sw-azure-toggle') as HTMLButtonElement;
    if (azureInput.type === 'password') { azureInput.type = 'text'; btn.textContent = 'Hide'; }
    else { azureInput.type = 'password'; btn.textContent = 'Show'; }
  });

  const keysError = card.querySelector('#sw-keys-error') as HTMLElement;

  const goToAdapterStep = () => {
    card.innerHTML = '';
    _renderAdapterStep(overlay, card, adapters, true, existingSlotIds);
  };

  // Skip — go straight to adapter step
  card.querySelector('#sw-keys-skip')?.addEventListener('click', goToAdapterStep);

  // Save keys then proceed
  card.querySelector('#sw-keys-save')?.addEventListener('click', async () => {
    const groqKey = groqInput.value.trim();
    const azureKey = azureInput.value.trim();
    const azureRegion = (card.querySelector('#sw-azure-region') as HTMLInputElement)?.value.trim() || 'eastus';

    if (!groqKey && !azureKey) {
      keysError.textContent = 'Enter at least one API key, or click Skip';
      keysError.style.display = 'block';
      return;
    }

    const saveBtn = card.querySelector('#sw-keys-save') as HTMLButtonElement;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    keysError.style.display = 'none';

    try {
      // Save Groq key if provided
      if (groqKey) {
        const resp = await fetch('/setup/groq-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groqApiKey: groqKey }),
        });
        const data = await resp.json();
        if (!data.ok) {
          keysError.textContent = data.error || 'Failed to save Groq key';
          keysError.style.display = 'block';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Continue';
          return;
        }
      }
      // Save Azure key if provided
      if (azureKey) {
        const resp = await fetch('/setup/azure-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ azureSpeechKey: azureKey, azureSpeechRegion: azureRegion }),
        });
        const data = await resp.json();
        if (!data.ok) {
          keysError.textContent = data.error || 'Failed to save Azure key';
          keysError.style.display = 'block';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Continue';
          return;
        }
      }
      goToAdapterStep();
    } catch (e) {
      keysError.textContent = String(e);
      keysError.style.display = 'block';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Continue';
    }
  });
}

// ── Step 2: Adapter selection ─────────────────────────────────────────────

function _renderAdapterStep(
  overlay: HTMLElement,
  card: HTMLElement,
  adapters: AdapterSchemas,
  isInitialSetup: boolean,
  existingSlotIds: Set<string>,
): void {
  const adapterIds = Object.keys(adapters);
  // Put claude-code first as default
  adapterIds.sort((a, b) => a === 'claude-code' ? -1 : b === 'claude-code' ? 1 : 0);
  const optionsHtml = adapterIds.map(id => {
    const label = ADAPTER_LABELS[id] || id;
    return `<option value="${id}"${id === 'claude-code' ? ' selected' : ''}>${label}</option>`;
  }).join('\n');

  const closeBtnHtml = isInitialSetup ? '' :
    `<button id="sw-close" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#8899aa;font-size:20px;cursor:pointer;padding:4px 8px;line-height:1;z-index:1;">✕</button>`;

  const stepLabel = isInitialSetup ? '<p style="margin:0 0 24px;color:#8899aa;font-size:14px;">Step 2 of 2 — Connect your AI agent</p>' :
    '<p style="margin:0 0 24px;color:#8899aa;font-size:14px;">Configure your voice interface</p>';

  card.innerHTML = `
    ${closeBtnHtml}
    <h2 style="margin:0 0 8px;font-size:22px;">TryVoice Setup</h2>
    ${stepLabel}

    <div style="margin-bottom:20px;">
      <label style="${LABEL_STYLE}">Mode</label>
      <select id="sw-mode" style="width:100%;padding:10px;background:#0d1520;color:#e0e8f0;border:1px solid #2a3a4a;border-radius:8px;font-size:14px;">
        ${optionsHtml}
      </select>
    </div>

    <div id="sw-adapter-fields"></div>

    <div id="sw-error" style="display:none;color:#eb4d4b;font-size:13px;margin-bottom:12px;"></div>

    <div id="sw-discovery-results" style="display:none;margin-bottom:20px;"></div>

    <button id="sw-submit" style="width:100%;padding:12px;background:#1f86ff;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600;">
      Start TryVoice
    </button>
  `;

  if (!overlay.parentNode) {
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // Bind close button
  card.querySelector('#sw-close')?.addEventListener('click', () => overlay.remove());

  const modeSelect = card.querySelector('#sw-mode') as HTMLSelectElement;
  const fieldsContainer = card.querySelector('#sw-adapter-fields') as HTMLElement;

  function renderAdapterFields(adapterId: string): void {
    fieldsContainer.innerHTML = '';
    const adapterInfo = adapters[adapterId];
    if (!adapterInfo || adapterInfo.schema.length === 0) return;

    const grouped: Record<string, SchemaField[]> = {};
    for (const f of adapterInfo.schema) {
      const g = f.group || 'connection';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(f);
    }

    for (const group of GROUP_ORDER) {
      const fields = grouped[group];
      if (!fields || fields.length === 0) continue;

      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '16px';

      if (group === 'advanced') {
        const details = document.createElement('details');
        details.style.marginBottom = '16px';
        const summary = document.createElement('summary');
        summary.style.cssText = 'cursor:pointer;color:#8899aa;font-size:13px;margin-bottom:8px;';
        summary.textContent = 'Advanced Settings';
        details.appendChild(summary);
        const inner = document.createElement('div');
        inner.style.marginTop = '12px';
        for (const f of fields) inner.appendChild(buildFieldEl(f));
        details.appendChild(inner);
        fieldsContainer.appendChild(details);
      } else {
        for (const f of fields) wrapper.appendChild(buildFieldEl(f));
        fieldsContainer.appendChild(wrapper);
      }
    }
  }

  function buildFieldEl(f: SchemaField): HTMLElement {
    const div = document.createElement('div');
    div.style.marginBottom = '16px';

    const label = document.createElement('label');
    label.style.cssText = LABEL_STYLE;
    label.textContent = f.label + (f.required ? ' *' : '');
    if (f.description) {
      const desc = document.createElement('span');
      desc.style.cssText = 'display:block;font-size:11px;color:#667788;margin-top:2px;';
      desc.textContent = f.description;
      label.appendChild(desc);
    }
    div.appendChild(label);

    if (f.fieldType === 'select' && f.options) {
      const select = document.createElement('select');
      select.id = `sw-field-${f.name}`;
      select.style.cssText = INPUT_STYLE;
      if (!f.required) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '— None —';
        select.appendChild(emptyOpt);
      }
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === f.default) o.selected = true;
        select.appendChild(o);
      }
      div.appendChild(select);
    } else if (f.fieldType === 'boolean') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `sw-field-${f.name}`;
      cb.checked = f.default === 'true';
      cb.style.cssText = 'margin-right:8px;';
      div.appendChild(cb);
    } else {
      const input = document.createElement('input');
      input.id = `sw-field-${f.name}`;
      input.style.cssText = INPUT_STYLE;
      if (f.fieldType === 'password') input.type = 'password';
      else if (f.fieldType === 'url') input.type = 'url';
      else if (f.fieldType === 'number') input.type = 'number';
      else input.type = 'text';
      if (f.default) input.placeholder = f.default;

      if (f.options && f.options.length > 0) {
        const listId = `sw-datalist-${f.name}`;
        const datalist = document.createElement('datalist');
        datalist.id = listId;
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          datalist.appendChild(o);
        }
        input.setAttribute('list', listId);
        div.appendChild(input);
        div.appendChild(datalist);
      } else {
        div.appendChild(input);
      }
    }

    return div;
  }

  renderAdapterFields(modeSelect.value);

  modeSelect.addEventListener('change', () => {
    renderAdapterFields(modeSelect.value);
  });

  const submitBtn = card.querySelector('#sw-submit') as HTMLButtonElement;
  const errorEl = card.querySelector('#sw-error') as HTMLElement;
  const discoveryEl = card.querySelector('#sw-discovery-results') as HTMLElement;

  let pendingBots: DiscoveredBot[] = [];

  const finishWizard = () => {
    // Reload to re-initialize with new config (WS, adapters, slots)
    window.location.reload();
  };

  submitBtn.addEventListener('click', async () => {
    // If discovery results are showing, this is the "Continue" click — sync selected bots
    if (discoveryEl.style.display !== 'none' && pendingBots.length > 0) {
      const selected = getSelectedBots(discoveryEl, pendingBots);
      const toRemove = getDeselectedExistingBots(discoveryEl, pendingBots);
      if (selected.length === 0 && toRemove.length === 0) {
        errorEl.textContent = 'Please select at least one bot';
        errorEl.style.display = 'block';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Syncing...';
      errorEl.style.display = 'none';
      try {
        for (const bot of toRemove) {
          await fetch(`/slots/${encodeURIComponent(bot.botId)}`, { method: 'DELETE' });
        }
        const newBots = selected.filter(b => !toRemove.find(r => r.botId === b.botId));
        if (newBots.length > 0) {
          const resp = await fetch('/setup/select-bots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bots: newBots, mode: isInitialSetup ? 'replace' : 'append' }),
          });
          const data = await resp.json();
          if (!data.ok) {
            errorEl.textContent = data.error || 'Failed to sync bots';
            errorEl.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Continue';
            return;
          }
        }
        finishWizard();
      } catch (e) {
        errorEl.textContent = String(e);
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
      }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Configuring...';
    errorEl.style.display = 'none';

    const adapterId = modeSelect.value;
    const adapterConfig: Record<string, string> = {};

    const adapterInfo = adapters[adapterId];
    if (adapterInfo) {
      for (const f of adapterInfo.schema) {
        const el = card.querySelector(`#sw-field-${f.name}`) as HTMLInputElement | HTMLSelectElement | null;
        if (!el) continue;
        let value = '';
        if (f.fieldType === 'boolean') {
          value = (el as HTMLInputElement).checked ? 'true' : 'false';
        } else {
          value = el.value.trim();
        }
        if (value) {
          adapterConfig[f.name] = value;
        } else if (f.required && !f.default) {
          errorEl.textContent = `${f.label} is required`;
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Start TryVoice';
          return;
        }
      }
    }

    const body: Record<string, unknown> = { adapterType: adapterId };
    if (Object.keys(adapterConfig).length > 0) {
      body.adapterConfig = adapterConfig;
    }

    try {
      const resp = await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.ok) {
        const discoveredBots: DiscoveredBot[] = data.discoveredBots || [];
        const discoveryError: string = data.discoveryError || '';
        const caps = adapterInfo?.capabilities;
        const supportsDiscovery = caps?.supportsDiscovery ?? false;

        if (supportsDiscovery && discoveredBots.length > 0) {
          pendingBots = discoveredBots;
          showDiscoveryResults(discoveryEl, discoveredBots, submitBtn, existingSlotIds, adapterInfo, pendingBots, errorEl, adapterId);
        } else if (supportsDiscovery && discoveryError) {
          showDiscoveryError(discoveryEl, discoveryError, submitBtn);
        } else if (supportsDiscovery && discoveredBots.length === 0) {
          showDiscoveryEmpty(discoveryEl, submitBtn, adapterInfo, pendingBots, errorEl, adapterId);
        } else {
          finishWizard();
        }
      } else {
        errorEl.textContent = data.error || 'Setup failed';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Start TryVoice';
      }
    } catch (e) {
      errorEl.textContent = String(e);
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start TryVoice';
    }
  });
}


function showDiscoveryResults(
  container: HTMLElement,
  bots: DiscoveredBot[],
  submitBtn: HTMLButtonElement,
  existingSlotIds: Set<string> = new Set(),
  adapterInfo?: AdapterInfo,
  pendingBots?: DiscoveredBot[],
  errorEl?: HTMLElement,
  adapterId?: string,
): void {
  container.style.display = 'block';

  const BADGE_STYLE = 'display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:6px;';
  const channelColors: Record<string, string> = {
    telegram: 'background:#2196F3;color:#fff;',
    webchat: 'background:#8BC34A;color:#fff;',
  };

  const rows = bots.map((b, i) => {
    const meta = (b.metadata || {}) as Record<string, unknown>;
    const channel = String(meta.channel || '');
    const agentName = String(meta.agentName || meta.agentId || '');
    const model = String(meta.model || '');
    const badgeColor = channelColors[channel] || 'background:#607D8B;color:#fff;';
    const channelBadge = channel ? `<span style="${BADGE_STYLE}${badgeColor}">${escapeHtml(channel)}</span>` : '';
    const agentLabel = agentName ? `<span style="color:#8899aa;font-size:11px;">agent: ${escapeHtml(agentName)}</span>` : '';
    const modelLabel = model ? `<span style="color:#667788;font-size:11px;margin-left:6px;">${escapeHtml(model)}</span>` : '';
    const isExisting = existingSlotIds.has(b.botId) || Boolean(meta.already_added);
    const isDirConflict = false;
    const isDisabled = false;
    const isClaudeSession = b.sessionKey?.startsWith('claude:');
    const attachBtnHtml = (isExisting && isClaudeSession)
      ? `<button class="sw-attach-btn" data-bot-id="${escapeHtml(b.botId)}" title="Open terminal"
          style="flex-shrink:0;padding:4px 8px;border:1px solid #2a3a4a;border-radius:4px;background:#0d1520;color:#8899aa;cursor:pointer;font-size:11px;white-space:nowrap;display:flex;align-items:center;gap:4px;"
          onclick="event.preventDefault();event.stopPropagation();">
          <svg width="12" height="12" viewBox="0 0 14 14"><path d="M2 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="11" x2="12" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Terminal
        </button>`
      : '';

    return `
      <label style="display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #1a2332;cursor:${isDisabled ? 'default' : 'pointer'};gap:10px;${isDisabled ? 'opacity:0.5;' : ''}">
        <input type="checkbox" data-bot-index="${i}" ${isExisting ? 'checked data-existing="1"' : ''} ${isDisabled ? 'disabled' : ''}
          style="width:16px;height:16px;accent-color:#1f86ff;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
            ${channelBadge}
            <span style="color:#e0e8f0;font-weight:500;font-size:13px;">${escapeHtml(b.name)}</span>
            ${isExisting ? '<span style="color:#4ade80;font-size:11px;margin-left:4px;">(already added)</span>' : ''}
          </div>
          <div style="margin-top:3px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
            ${agentLabel}${modelLabel}
          </div>
        </div>
        ${attachBtnHtml}
      </label>
    `;
  }).join('');

  container.innerHTML = `
    <div style="border:1px solid #2a3a4a;border-radius:8px;padding:16px;background:#0d1520;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <h3 style="margin:0;font-size:15px;color:#4ade80;">Discovered ${bots.length} Bot${bots.length > 1 ? 's' : ''}</h3>
        <button id="sw-toggle-all" style="background:none;border:1px solid #2a3a4a;color:#8899aa;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;">
          Select All
        </button>
      </div>
      <div style="max-height:260px;overflow-y:auto;">
        ${rows}
      </div>
    </div>
  `;

  // Toggle all button
  const toggleBtn = container.querySelector('#sw-toggle-all') as HTMLButtonElement;
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const cbs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([disabled])');
      const allChecked = Array.from(cbs).every(cb => cb.checked);
      cbs.forEach(cb => { cb.checked = !allChecked; });
      toggleBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
    });
  }

  // Attach terminal buttons for existing Claude Code bots
  container.querySelectorAll<HTMLButtonElement>('.sw-attach-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const botId = btn.dataset.botId;
      if (!botId) return;
      fetch(`/slots/${encodeURIComponent(botId)}/attach-terminal`, { method: 'POST' })
        .then(() => { btn.textContent = 'Opened'; btn.disabled = true; })
        .catch(() => {});
    });
  });

  // Render "Create New Session" form if adapter supports creation
  if (adapterInfo?.capabilities?.supportsCreation && pendingBots && errorEl) {
    _renderCreateBotForm(container, adapterInfo, pendingBots, existingSlotIds, submitBtn, errorEl, adapterId);
  }

  submitBtn.disabled = false;
  submitBtn.textContent = 'Continue';
}


function getSelectedBots(container: HTMLElement, bots: DiscoveredBot[]): DiscoveredBot[] {
  const selected: DiscoveredBot[] = [];
  const cbs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  cbs.forEach(cb => {
    if (!cb.checked) return;
    const idx = parseInt(cb.getAttribute('data-bot-index') || '-1', 10);
    if (idx >= 0 && idx < bots.length) {
      selected.push(bots[idx]);
    }
  });
  return selected;
}


function getDeselectedExistingBots(container: HTMLElement, bots: DiscoveredBot[]): DiscoveredBot[] {
  const deselected: DiscoveredBot[] = [];
  const cbs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-existing="1"]');
  cbs.forEach(cb => {
    if (cb.checked) return;
    const idx = parseInt(cb.getAttribute('data-bot-index') || '-1', 10);
    if (idx >= 0 && idx < bots.length) {
      deselected.push(bots[idx]);
    }
  });
  return deselected;
}


function showDiscoveryEmpty(
  container: HTMLElement,
  submitBtn: HTMLButtonElement,
  adapterInfo?: AdapterInfo,
  pendingBots?: DiscoveredBot[],
  errorEl?: HTMLElement,
  adapterId?: string,
): void {
  container.style.display = 'block';
  container.innerHTML = `
    <div style="border:1px solid #2a3a4a;border-radius:8px;padding:16px;background:#0d1520;">
      <p style="margin:0;font-size:13px;color:#8899aa;">
        No bots discovered. You can scan again later from the settings panel.
      </p>
    </div>
  `;

  // Show create form directly when no bots found and adapter supports creation
  if (adapterInfo?.capabilities?.supportsCreation && pendingBots && errorEl) {
    _renderCreateBotForm(container, adapterInfo, pendingBots, new Set(), submitBtn, errorEl, adapterId);
  }

  submitBtn.disabled = false;
  submitBtn.textContent = 'Continue';
}


function showDiscoveryError(
  container: HTMLElement,
  error: string,
  submitBtn: HTMLButtonElement,
): void {
  container.style.display = 'block';
  container.innerHTML = `
    <div style="border:1px solid #5a3a3a;border-radius:8px;padding:16px;background:#1a1015;">
      <h3 style="margin:0 0 8px;font-size:15px;color:#eb4d4b;">Discovery Failed</h3>
      <p style="margin:0 0 8px;font-size:13px;color:#cc9999;">
        Could not discover bots from the gateway. Check the gateway URL and token, then try again from the settings panel.
      </p>
      <pre style="margin:0;font-size:11px;color:#667788;white-space:pre-wrap;word-break:break-all;">${escapeHtml(error)}</pre>
    </div>
  `;
  submitBtn.disabled = false;
  submitBtn.textContent = 'Continue';
}


function _renderCreateBotForm(
  container: HTMLElement,
  adapterInfo: AdapterInfo,
  pendingBots: DiscoveredBot[],
  existingSlotIds: Set<string>,
  submitBtn: HTMLButtonElement,
  errorEl: HTMLElement,
  adapterId?: string,
): void {
  const schema = adapterInfo.createBotSchema || [];
  if (schema.length === 0) return;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;border:1px solid #2a3a4a;border-radius:8px;background:#0d1520;overflow:hidden;';

  const header = document.createElement('button');
  header.type = 'button';
  header.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;padding:12px 16px;background:none;border:none;color:#1f86ff;font-size:14px;font-weight:600;cursor:pointer;text-align:left;';
  header.innerHTML = '<span style="font-size:18px;">＋</span> Create New Session';

  const formBody = document.createElement('div');
  formBody.style.cssText = 'display:none;padding:0 16px 16px;';

  // Build fields from schema
  for (const field of schema) {
    const div = document.createElement('div');
    div.style.marginBottom = '12px';
    const label = document.createElement('label');
    label.style.cssText = LABEL_STYLE;
    label.textContent = field.label + (field.required ? ' *' : '');
    if (field.description) {
      const desc = document.createElement('span');
      desc.style.cssText = 'display:block;font-size:11px;color:#667788;margin-top:2px;';
      desc.textContent = field.description;
      label.appendChild(desc);
    }
    div.appendChild(label);
    const input = document.createElement('input');
    input.id = `sw-create-${field.name}`;
    input.type = 'text';
    input.style.cssText = INPUT_STYLE;
    if (field.default) input.placeholder = field.default;
    div.appendChild(input);
    formBody.appendChild(div);
  }

  // Create button
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.style.cssText = 'width:100%;padding:10px;background:#1f86ff;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;';
  createBtn.textContent = 'Create';
  formBody.appendChild(createBtn);

  const createError = document.createElement('div');
  createError.style.cssText = 'display:none;color:#eb4d4b;font-size:12px;margin-top:8px;';
  formBody.appendChild(createError);

  // Toggle expand/collapse
  header.addEventListener('click', () => {
    const isOpen = formBody.style.display !== 'none';
    formBody.style.display = isOpen ? 'none' : 'block';
  });

  // Submit create
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    createError.style.display = 'none';

    const params: Record<string, string> = {};
    for (const field of schema) {
      const input = formBody.querySelector(`#sw-create-${field.name}`) as HTMLInputElement | null;
      const val = input?.value.trim() || '';
      if (val) {
        params[field.name] = val;
      } else if (field.required && !field.default) {
        createError.textContent = `${field.label} is required`;
        createError.style.display = 'block';
        createBtn.disabled = false;
        createBtn.textContent = 'Create';
        return;
      }
    }

    try {
      const resp = await fetch('/adapter/create-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params, adapterType: adapterId }),
      });
      const data = await resp.json();
      if (!data.ok) {
        createError.textContent = data.error || 'Creation failed';
        createError.style.display = 'block';
        createBtn.disabled = false;
        createBtn.textContent = 'Create';
        return;
      }

      // Add the new bot to pendingBots and refresh the discovery list
      const newBot: DiscoveredBot = data.bot;
      pendingBots.push(newBot);

      // Re-render the discovery results with updated bot list
      showDiscoveryResults(container, pendingBots, submitBtn, existingSlotIds, adapterInfo, pendingBots, errorEl, adapterId);

      // Auto-check the newly created bot
      const cbs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      cbs.forEach(cb => {
        const idx = parseInt(cb.getAttribute('data-bot-index') || '-1', 10);
        if (idx === pendingBots.length - 1) cb.checked = true;
      });
    } catch (e) {
      createError.textContent = String(e);
      createError.style.display = 'block';
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  });

  wrapper.appendChild(header);
  wrapper.appendChild(formBody);
  container.appendChild(wrapper);
}


function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
