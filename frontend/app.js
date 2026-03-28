import { API_BASE_URL } from './config.js';
import { csvToJson } from './utils.js';

// =====================================================
// STATE
// =====================================================
const state = {
  data: [],          // raw loaded data
  currentUrl: '',    // Google Sheet URL
  analysisResult: null, // last analysis: { data, bottleneck, explanation, avgTime, avgFailure, avgDep }
  isLoading: false,
  chatMessages: [],
  isChatLoading: false,
  comparisonSummary: null,
};

let autoRefreshInterval = null;

// =====================================================
// ANALYSIS
// =====================================================
function calculateScore(d) {
  return (0.5 * d.time) + (0.3 * d.failure) + (0.2 * d.dependency);
}

function analyze(records) {
  const aggregated = aggregateByProcess(records);
  return analyzeAggregatedProcesses(aggregated, records.length);
}

function analyzeAggregatedProcesses(processes, sourceRowCount = processes.reduce((sum, item) => sum + (item.sampleSize || 1), 0)) {
  const enriched = processes.map(d => ({ ...d, score: calculateScore(d) }));
  const max = Math.max(...enriched.map(d => d.score));
  const bottleneck = enriched.find(d => d.score === max);

  const avgTime = enriched.reduce((s, d) => s + d.time, 0) / enriched.length;
  const avgFailure = enriched.reduce((s, d) => s + d.failure, 0) / enriched.length;
  const avgDep = enriched.reduce((s, d) => s + d.dependency, 0) / enriched.length;

  const reasons = [];
  if (bottleneck.time > avgTime) reasons.push('high processing time');
  if (bottleneck.failure > avgFailure) reasons.push('high failure rate');
  if (bottleneck.dependency > avgDep) reasons.push('high dependency impact');

  const explanation = reasons.length > 0
    ? `because across most records it shows ${reasons.join(', ')}`
    : 'due to its combined average factor weight across the uploaded records';

  state.analysisResult = {
    data: enriched,
    bottleneck,
    explanation,
    avgTime,
    avgFailure,
    avgDep,
    sourceRowCount,
    processCount: enriched.length,
  };
  return state.analysisResult;
}

function aggregateByProcess(records) {
  const grouped = new Map();

  records.forEach(record => {
    const key = record.step;
    if (!grouped.has(key)) {
      grouped.set(key, {
        step: key,
        time: 0,
        failure: 0,
        dependency: 0,
        count: 0,
        people: new Set(),
      });
    }

    const entry = grouped.get(key);
    entry.time += record.time;
    entry.failure += record.failure;
    entry.dependency += record.dependency;
    entry.count += 1;
    if (record.person) entry.people.add(record.person);
  });

  return [...grouped.values()].map(entry => ({
    step: entry.step,
    time: entry.time / entry.count,
    failure: entry.failure / entry.count,
    dependency: entry.dependency / entry.count,
    sampleSize: entry.count,
    peopleCount: entry.people.size,
  }));
}

// =====================================================
// DATA LOADING
// =====================================================
function parseRawData(rows) {
  return rows
    .map(d => {
      const step = pickField(d, ['Process/Step', 'Process', 'Step', 'Stage', 'Process Name', 'Step Name']);
      const person = pickField(d, ['Person', 'Employee', 'User', 'Candidate', 'Customer', 'Name', 'Person Name']);
      const time = parseNumericField(d, ['Time', 'Processing Time', 'Duration', 'Cycle Time', 'Delay']);
      const failure = parseFailureField(d);
      const dependency = parseDependencyField(d);

      return {
        person: person || '',
        step: step || '',
        time,
        failure,
        dependency,
      };
    })
    .filter(d => d.step && Number.isFinite(d.time) && Number.isFinite(d.failure) && Number.isFinite(d.dependency));
}

function pickField(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && `${row[name]}`.trim() !== '') {
      return `${row[name]}`.trim();
    }
  }
  return '';
}

function parseNumericField(row, names) {
  const rawValue = pickField(row, names);
  if (!rawValue) return 0;
  const normalized = rawValue.replace(/,/g, '').replace(/%/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseFailureField(row) {
  const rawValue = pickField(row, ['Failure', 'Failure Rate', 'Error Rate', 'Defect Rate']);
  if (!rawValue) return 0;

  const normalized = rawValue.toLowerCase();
  if (['yes', 'true', 'failed', 'failure', '1'].includes(normalized)) return 1;
  if (['no', 'false', 'ok', 'pass', 'passed', '0'].includes(normalized)) return 0;

  const numeric = Number(normalized.replace(/%/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseDependencyField(row) {
  const rawValue = pickField(row, ['Dependency', 'Dependency Impact', 'Blockers', 'Risk']);
  if (!rawValue) return 0;

  const normalized = rawValue.toLowerCase();
  if (['start', 'none', 'na', 'n/a', 'null', 'root'].includes(normalized)) return 0;

  const numeric = Number(normalized.replace(/,/g, ''));
  if (Number.isFinite(numeric)) return numeric;

  return 1;
}

async function loadFromUrl(url) {
  state.isLoading = true;
  renderCurrentPage();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const rows = csvToJson(csv);
    state.data = parseRawData(rows);
    analyze(state.data);
    await persistAnalysisSnapshot();
    state.chatMessages = [];
    showToast('Data loaded successfully', 'success');
    updateNavbarStatus();
    navigateTo('dashboard');
  } catch (err) {
    showToast('Failed to load sheet. Check the URL.', 'error');
    console.error(err);
  } finally {
    state.isLoading = false;
    renderCurrentPage();
  }
}

function loadFromFile(file) {
  state.isLoading = true;
  renderCurrentPage();
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const rows = csvToJson(e.target.result);
      state.data = parseRawData(rows);
      if (!state.data.length || isNaN(state.data[0].time)) throw new Error('Invalid CSV');
      analyze(state.data);
      await persistAnalysisSnapshot();
      state.chatMessages = [];
      state.isLoading = false;
      showToast(`CSV uploaded - ${state.data.length} records grouped into ${state.analysisResult.processCount} processes`, 'success');
      navigateTo('dashboard');
      renderCurrentPage();
    } catch (err) {
      state.isLoading = false;
      showToast('Invalid CSV. Expected process data like Person, Process/Step, Time, Failure, Dependency', 'error');
      renderCurrentPage();
    }
  };
  reader.readAsText(file);
}

// =====================================================
// ROUTING
// =====================================================
const PAGE_META = {
  dashboard:  { label: 'Dashboard' },
  simulation: { label: 'Simulation' },
  data:       { label: 'Data' },
  insights:   { label: 'Insights' },
  recommendations: { label: 'Recommendations' },
  'ai-chat':  { label: 'AI Chat' },
};

function getCurrentPage() {
  const hash = window.location.hash.slice(1);
  return PAGE_META[hash] ? hash : 'dashboard';
}

function navigateTo(page) {
  window.location.hash = page;
}

function router() {
  const page = getCurrentPage();
  updateNavActive(page);
  updateBreadcrumb(page);
  renderPage(page);
}

function renderCurrentPage() {
  renderPage(getCurrentPage());
}

function updateNavActive(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
}

function updateBreadcrumb(page) {
  const el = document.getElementById('breadcrumb');
  if (el) el.textContent = PAGE_META[page]?.label || 'Dashboard';
}

function updateNavbarStatus() {
  const pill = document.getElementById('statusPill');
  const btn = document.getElementById('navRefreshBtn');
  if (state.currentUrl) {
    if (pill) pill.style.display = 'flex';
    if (btn) btn.style.display = 'inline-flex';
  } else {
    if (pill) pill.style.display = 'none';
    if (btn) btn.style.display = 'none';
  }
}

function renderPage(page) {
  const content = document.getElementById('contentArea');
  if (!content) return;

  switch (page) {
    case 'dashboard':  content.innerHTML = renderDashboard(); break;
    case 'simulation': content.innerHTML = renderSimulation(); break;
    case 'data':       content.innerHTML = renderDataPage(); break;
    case 'insights':   content.innerHTML = renderInsightsPage(); break;
    case 'recommendations': content.innerHTML = renderRecommendationsPage(); break;
    case 'ai-chat':    content.innerHTML = renderAiChatPage(); break;
    default:           content.innerHTML = renderDashboard();
  }

  // Refresh Lucide icons for dynamically rendered content
  if (window.lucide) lucide.createIcons();

  bindPageEvents(page);
}

// =====================================================
// DASHBOARD PAGE
// =====================================================
function renderDashboard() {
  if (state.isLoading) return renderSkeletonLoader();
  if (!state.analysisResult) {
    return renderEmptyState(
      'No Data Loaded',
      'Upload a CSV file or connect a Google Sheet to start analyzing your process pipeline.',
      `<a class="btn btn-primary" href="#data">
        ${iconSvg('upload')} Import Data
      </a>`
    );
  }

  const { data, bottleneck, explanation } = state.analysisResult;
  return `
    <div class="page-dashboard">
      ${renderBottleneckAlert(bottleneck, explanation)}
      ${renderComparisonAlert()}

      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Process Pipeline</h2>
          <span class="section-subtitle">${data.length} stages analyzed</span>
        </div>
        <div class="card" style="padding: var(--sp-5);">
          ${renderPipelineStepper(data, bottleneck)}
        </div>
      </section>

      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Stage Analysis</h2>
          <span class="section-subtitle">Detailed metrics per stage</span>
        </div>
        <div class="stage-cards-grid">
          ${data.map(d => renderStageCard(d, bottleneck, data)).join('')}
        </div>
      </section>

      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Score Comparison</h2>
        </div>
        ${renderScoreChart(data, bottleneck)}
      </section>
    </div>
  `;
}

function renderComparisonAlert() {
  if (!state.comparisonSummary?.message) return '';

  const type = state.comparisonSummary.type === 'improved'
    ? 'success'
    : state.comparisonSummary.type === 'baseline'
    ? 'warning'
    : state.comparisonSummary.type === 'unchanged'
    ? 'warning'
    : 'danger';

  return `
    <div class="alert alert-${type}" role="status">
      <div class="alert-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/><path d="M12 4h9"/><path d="M4 9h16"/><path d="M4 15h16"/><path d="M8 4v16"/>
        </svg>
      </div>
      <div class="alert-content">
        <div class="alert-title">Comparison With Previous Upload</div>
        <div class="alert-desc">${state.comparisonSummary.message}</div>
      </div>
    </div>
  `;
}

function renderBottleneckAlert(bottleneck, explanation) {
  return `
    <div class="alert alert-danger" role="alert">
      <div class="alert-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>
        </svg>
      </div>
      <div class="alert-content">
        <div class="alert-title">Bottleneck Detected: ${bottleneck.step}</div>
        <div class="alert-desc">
          The <strong>${bottleneck.step}</strong> stage is the critical bottleneck ${explanation}
          — bottleneck score: <strong>${bottleneck.score.toFixed(2)}</strong>
        </div>
      </div>
    </div>
  `;
}

// =====================================================
// PIPELINE STEPPER
// =====================================================
function renderPipelineStepper(data, bottleneck) {
  return `
    <div class="pipeline-stepper">
      ${data.map((d, i) => {
        const status = getStatus(d, bottleneck, data);
        const icon = status === 'danger'
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`
          : status === 'warning'
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        const connectorClass = status === 'danger' ? 'connector-danger' : status === 'warning' ? 'connector-warning' : '';
        return `
          ${i > 0 ? `<div class="pipeline-connector ${connectorClass}"></div>` : ''}
          <div class="pipeline-step">
            <div class="step-node step-${status}">${icon}</div>
            <div class="step-label">${d.step}</div>
            <span class="badge badge-${status}">${d.score.toFixed(2)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// =====================================================
// STAGE CARDS (read-only)
// =====================================================
function renderStageCard(d, bottleneck, data) {
  const status = getStatus(d, bottleneck, data);
  const maxScore = Math.max(...data.map(x => x.score));
  const pct = Math.round((d.score / maxScore) * 100);
  const label = status === 'danger' ? 'Bottleneck' : status === 'warning' ? 'At Risk' : 'Healthy';

  return `
    <div class="stage-card stage-card-${status}">
      <div class="stage-card-header">
        <div class="stage-card-title">${d.step}</div>
        <span class="badge badge-${status}">${label}</span>
      </div>
      <div class="stage-score-section">
        <div class="stage-score-value">${d.score.toFixed(2)}</div>
        <div class="stage-score-label">Bottleneck Score</div>
        <div class="progress-bar">
          <div class="progress-fill progress-fill-${status}" style="width:${pct}%"></div>
        </div>
      </div>
      <div class="stage-metrics">
        <div class="stage-metric">
          ${clockIcon()}
          <span class="metric-label">Time</span>
          <span class="metric-value">${d.time}</span>
        </div>
        <div class="stage-metric">
          ${xCircleIcon()}
          <span class="metric-label">Failure</span>
          <span class="metric-value">${d.failure}</span>
        </div>
        <div class="stage-metric">
          ${gitMergeIcon()}
          <span class="metric-label">Dependency</span>
          <span class="metric-value">${d.dependency}</span>
        </div>
      </div>
    </div>
  `;
}

// =====================================================
// SCORE CHART
// =====================================================
function renderScoreChart(data, bottleneck) {
  const maxScore = Math.max(...data.map(d => d.score));
  return `
    <div class="score-chart card">
      ${data.map(d => {
        const status = getStatus(d, bottleneck, data);
        const width = Math.max(8, Math.round((d.score / maxScore) * 100));
        return `
          <div class="chart-row">
            <div class="chart-label">${d.step}</div>
            <div class="chart-bar-container">
              <div class="chart-bar chart-bar-${status}" style="width:${width}%">
                <span class="chart-bar-value">${d.score.toFixed(2)}</span>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// =====================================================
// SIMULATION PAGE
// =====================================================
function renderSimulation() {
  if (!state.analysisResult) {
    return renderEmptyState(
      'No Data for Simulation',
      'Load your process data first to run scenario simulations.',
      `<a class="btn btn-primary" href="#data">${iconSvg('upload')} Import Data</a>`
    );
  }

  const { data, bottleneck } = state.analysisResult;
  return `
    <div class="page-simulation">
      <div class="page-intro">
        <h2 class="page-title">Scenario Simulation</h2>
        <p class="page-desc">Adjust stage parameters below and run the simulation to see how changes impact your pipeline bottleneck.</p>
      </div>

      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Edit Parameters</h2>
          <span class="section-subtitle">Modify values per stage, then run simulation</span>
        </div>
        <div class="stage-cards-grid">
          ${data.map(d => renderEditableStageCard(d, bottleneck, data)).join('')}
        </div>
      </section>

      <div class="sim-actions">
        <button class="btn btn-primary btn-lg" id="runSimBtn">
          ${iconSvg('play')} Run Simulation
        </button>
        <button class="btn btn-ghost" id="resetSimBtn">
          ${iconSvg('rotate-ccw')} Reset to Original
        </button>
      </div>
    </div>
  `;
}

function renderEditableStageCard(d, bottleneck, data) {
  const status = getStatus(d, bottleneck, data);
  const label = status === 'danger' ? 'Bottleneck' : status === 'warning' ? 'At Risk' : 'Healthy';
  return `
    <div class="stage-card stage-card-${status}">
      <div class="stage-card-header">
        <div class="stage-card-title">${d.step}</div>
        <span class="badge badge-${status}">${label}</span>
      </div>
      <div class="stage-edit-inputs">
        <div class="input-group">
          <label class="input-label">${clockIcon()} Processing Time</label>
          <input type="number" class="input input-number sim-time" data-step="${d.step}" value="${d.time}" step="0.1" min="0" aria-label="${d.step} processing time">
        </div>
        <div class="input-group">
          <label class="input-label">${xCircleIcon()} Failure Rate</label>
          <input type="number" class="input input-number sim-failure" data-step="${d.step}" value="${d.failure}" step="0.01" min="0" max="1" aria-label="${d.step} failure rate">
        </div>
        <div class="input-group">
          <label class="input-label">${gitMergeIcon()} Dependency</label>
          <input type="number" class="input input-number sim-dependency" data-step="${d.step}" value="${d.dependency}" step="0.1" min="0" aria-label="${d.step} dependency">
        </div>
      </div>
    </div>
  `;
}

// =====================================================
// DATA PAGE
// =====================================================
function renderDataPage() {
  const hasData = state.data.length > 0;
  return `
    <div class="page-data">
      <div class="page-intro">
        <h2 class="page-title">Data Management</h2>
        <p class="page-desc">Upload a CSV file or connect a public Google Sheet to analyze your process pipeline.</p>
      </div>

      <div class="data-sources-grid">
        <!-- CSV Upload -->
        <div class="card upload-card">
          <div class="upload-card-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
          </div>
          <h3 class="upload-card-title">Upload CSV File</h3>
          <p class="upload-card-desc">Upload a local CSV file with columns like <strong>Person, Process/Step, Time, Failure, Dependency</strong>. WeakLink averages each process across all uploaded records before finding the bottleneck.</p>
          <div class="file-drop-zone" id="fileDropZone">
            <svg class="drop-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" x2="12" y1="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
            <p>Drag &amp; drop your CSV here</p>
            <span style="font-size:var(--text-xs);color:var(--color-text-muted)">or</span>
            <label class="btn btn-secondary btn-sm" style="cursor:pointer">
              Browse Files
              <input type="file" id="fileInput" accept=".csv" style="display:none" aria-label="Browse CSV file">
            </label>
          </div>
          <button class="btn btn-primary w-full" id="loadFileBtn">
            ${iconSvg('upload')} Upload Data
          </button>
        </div>

        <!-- Google Sheet -->
        <div class="card upload-card">
          <div class="upload-card-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>
          <h3 class="upload-card-title">Google Sheets</h3>
          <p class="upload-card-desc">Paste a public Google Sheet CSV export link for live auto-refresh every 30s.</p>
          <div class="input-group">
            <label class="input-label" for="sheetUrlInput">Sheet CSV URL</label>
            <input type="url" id="sheetUrlInput" class="input" placeholder="https://docs.google.com/spreadsheets/.../export?format=csv" value="${state.currentUrl}" aria-label="Google Sheet CSV URL">
          </div>
          <div class="sheet-actions">
            <button class="btn btn-primary flex-1" id="loadSheetBtn">
              ${iconSvg('link')} Load Sheet
            </button>
            ${state.currentUrl ? `
              <button class="btn btn-secondary" id="dataRefreshBtn">
                ${iconSvg('refresh-cw')} Refresh
              </button>
            ` : ''}
          </div>
        </div>
      </div>

      ${hasData ? `
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Process Summary</h2>
            <span class="badge badge-success">${state.data.length} records across ${state.analysisResult?.processCount || 0} processes</span>
          </div>
          ${renderDataTable(state.analysisResult?.data || [])}
        </section>
      ` : `
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Expected CSV Format</h2>
          </div>
          <div class="card sample-format-card">
            <p class="page-desc" style="margin-bottom:var(--sp-4)">Your CSV should include one row per person-process record. WeakLink groups rows by process and averages the metrics before choosing the bottleneck.</p>
            <div class="table-wrapper" style="border-radius:var(--radius-md);border:1px solid var(--color-border);overflow:hidden">
              <table class="data-table">
                <thead>
                  <tr><th>Person</th><th>Process</th><th>Time</th><th>Failure</th><th>Dependency</th></tr>
                </thead>
                <tbody>
                  <tr><td>Asha</td><td class="table-step-cell">Order Review</td><td>2</td><td>0.1</td><td>0.5</td></tr>
                  <tr><td>Ravi</td><td class="table-step-cell">Order Review</td><td>3</td><td>0.2</td><td>0.4</td></tr>
                  <tr><td>Asha</td><td class="table-step-cell">Fulfillment</td><td>6</td><td>0.8</td><td>0.9</td></tr>
                  <tr><td>Ravi</td><td class="table-step-cell">Fulfillment</td><td>5</td><td>0.6</td><td>0.8</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `}
    </div>
  `;
}

function renderDataTable(data) {
  return `
    <div class="table-wrapper card" style="padding:0">
      <table class="data-table">
        <thead>
          <tr>
            <th>Process</th>
            <th>Average Time</th>
            <th>Average Failure</th>
            <th>Average Dependency</th>
            <th>Samples</th>
            <th>People</th>
            <th>Score</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.map(d => {
            const status = getStatus(d, state.analysisResult.bottleneck, data);
            const label = status === 'danger' ? 'Bottleneck' : status === 'warning' ? 'At Risk' : 'Healthy';
            return `
              <tr>
                <td class="table-step-cell">${d.step}</td>
                <td>${d.time.toFixed(2)}</td>
                <td>${d.failure.toFixed(2)}</td>
                <td>${d.dependency.toFixed(2)}</td>
                <td>${d.sampleSize}</td>
                <td>${d.peopleCount || d.sampleSize}</td>
                <td class="text-${status === 'danger' ? 'danger' : status === 'warning' ? 'warning' : 'success'} font-semibold">${d.score.toFixed(2)}</td>
                <td><span class="badge badge-${status}">${label}</span></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function renderInsightsPage() {
  if (!state.analysisResult) {
    return renderEmptyState(
      'No Insights Available',
      'Load your process data first to generate insights and recommendations.',
      `<a class="btn btn-primary" href="#data">${iconSvg('upload')} Import Data</a>`
    );
  }

  const { data, bottleneck, explanation, avgTime, avgFailure, avgDep } = state.analysisResult;
  const maxScore = Math.max(...data.map(d => d.score));
  const totalTime = data.reduce((s, d) => s + d.time, 0);
  const healthyCount = data.filter(d => getStatus(d, bottleneck, data) === 'healthy').length;

  return `
    <div class="page-insights">
      <div class="page-intro">
        <h2 class="page-title">Process Insights</h2>
        <p class="page-desc">Deep analysis of your process pipeline performance and bottleneck impact.</p>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon stat-icon-primary">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>
          </div>
          <div class="stat-value">${data.length}</div>
          <div class="stat-label">Total Stages</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-success">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div class="stat-value">${healthyCount}</div>
          <div class="stat-label">Healthy Stages</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-warning">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="stat-value">${totalTime.toFixed(1)}</div>
          <div class="stat-label">Total Process Time</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-danger">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
          </div>
          <div class="stat-value">${maxScore.toFixed(2)}</div>
          <div class="stat-label">Bottleneck Score</div>
        </div>
      </div>

      <div class="insights-grid">
        <section class="section" style="margin-bottom:0">
          <div class="section-header">
            <h2 class="section-title">Score Breakdown</h2>
          </div>
          ${renderScoreChart(data, bottleneck)}
        </section>

        <section class="section" style="margin-bottom:0">
          <div class="section-header">
            <h2 class="section-title">Bottleneck Analysis</h2>
          </div>
          <div class="card">
            <div class="bottleneck-detail">
              <div class="bottleneck-stage-badge">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                ${bottleneck.step}
              </div>
              <p class="bottleneck-explanation">
                The <strong>${bottleneck.step}</strong> process is the primary bottleneck ${explanation}.
              </p>
              <div class="bottleneck-metrics">
                <div class="metric-row">
                  <span class="metric-label">${clockIcon()} Processing Time</span>
                  <span class="metric-value ${bottleneck.time > avgTime ? 'text-danger' : 'text-success'}">
                    ${bottleneck.time} &nbsp;${bottleneck.time > avgTime ? '↑ Above avg' : '✓ Normal'}
                  </span>
                </div>
                <div class="metric-row">
                  <span class="metric-label">${xCircleIcon()} Failure Rate</span>
                  <span class="metric-value ${bottleneck.failure > avgFailure ? 'text-danger' : 'text-success'}">
                    ${bottleneck.failure} &nbsp;${bottleneck.failure > avgFailure ? '↑ Above avg' : '✓ Normal'}
                  </span>
                </div>
                <div class="metric-row">
                  <span class="metric-label">${gitMergeIcon()} Dependency</span>
                  <span class="metric-value ${bottleneck.dependency > avgDep ? 'text-danger' : 'text-success'}">
                    ${bottleneck.dependency} &nbsp;${bottleneck.dependency > avgDep ? '↑ Above avg' : '✓ Normal'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderRecommendationsPage() {
  if (!state.analysisResult) {
    return renderEmptyState(
      'No Recommendations Available',
      'Load your process data first so WeakLink can generate improvement recommendations.',
      `<a class="btn btn-primary" href="#data">${iconSvg('upload')} Import Data</a>`
    );
  }

  const recommendations = getRecommendationInsights();
  const highPriority = recommendations.filter(item => item.priority === 'high').length;

  return `
    <div class="page-recommendations">
      <div class="page-intro">
        <h2 class="page-title">Recommendations</h2>
        <p class="page-desc">Actionable next steps generated from the current bottleneck pattern, process averages, and risk spread across your uploaded workflow data.</p>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon stat-icon-danger">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
          </div>
          <div class="stat-value">${highPriority}</div>
          <div class="stat-label">High Priority Actions</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-primary">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M12 4h9"/><path d="M4 9h16"/><path d="M4 15h16"/><path d="M8 4v16"/></svg>
          </div>
          <div class="stat-value">${state.analysisResult.bottleneck.step}</div>
          <div class="stat-label">Primary Target Process</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-warning">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="stat-value">${state.analysisResult.bottleneck.score.toFixed(2)}</div>
          <div class="stat-label">Current Bottleneck Score</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon stat-icon-success">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div class="stat-value">${state.analysisResult.processCount}</div>
          <div class="stat-label">Processes Reviewed</div>
        </div>
      </div>

      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Recommended Actions</h2>
          <span class="section-subtitle">Prioritized by current workflow pain points</span>
        </div>
        ${renderRecommendations(recommendations)}
      </section>
    </div>
  `;
}

// =====================================================
// AI CHAT PAGE
// =====================================================
function renderAiChatPage() {
  if (!state.analysisResult) {
    return renderEmptyState(
      'No Data Loaded',
      'Upload a CSV file or connect a Google Sheet first, then ask the AI chat to analyze the loaded data.',
      `<a class="btn btn-primary" href="#data">${iconSvg('upload')} Import Data</a>`
    );
  }

  if (!state.chatMessages.length) {
    seedChat();
  }

  return `
    <div class="page-ai-chat">
      <div class="page-intro">
        <h2 class="page-title">AI Data Chat</h2>
        <p class="page-desc">Ask questions about the uploaded CSV or connected Google Sheet. The chat answers from the currently loaded dataset and process analysis.</p>
      </div>

      <div class="ai-chat-layout">
        <section class="card ai-chat-panel">
          <div class="ai-chat-header">
            <div>
              <h3 class="section-title">Conversation</h3>
              <p class="section-subtitle">Grounded in ${state.analysisResult.sourceRowCount} records across ${state.analysisResult.processCount} averaged processes</p>
            </div>
            <button class="btn btn-secondary btn-sm" id="clearChatBtn">
              ${iconSvg('rotate-ccw')} Clear
            </button>
          </div>

          <div class="chat-thread" id="chatThread">
            ${state.chatMessages.map(renderChatMessage).join('')}
          </div>

          <div class="chat-composer">
            <div class="chat-suggestions">
              ${getSuggestedQuestions().map(question => `
                <button class="chat-chip" data-chat-question="${escapeAttribute(question)}">${question}</button>
              `).join('')}
            </div>

            <form class="chat-form" id="aiChatForm">
              <textarea
                id="aiChatInput"
                class="chat-input"
                rows="3"
                placeholder="Ask about bottlenecks, averages, risky stages, totals, or comparisons..."
              ></textarea>
              <button class="btn btn-primary" type="submit">
                ${iconSvg('send')} Ask
              </button>
            </form>
          </div>
        </section>

        <aside class="card ai-chat-sidebar">
          <h3 class="section-title">Dataset Snapshot</h3>
          <div class="chat-facts">
            <div class="chat-fact">
              <span class="chat-fact-label">Processes</span>
              <strong>${state.analysisResult.processCount}</strong>
            </div>
            <div class="chat-fact">
              <span class="chat-fact-label">Bottleneck</span>
              <strong>${state.analysisResult.bottleneck.step}</strong>
            </div>
            <div class="chat-fact">
              <span class="chat-fact-label">Total time</span>
              <strong>${sumMetric('time').toFixed(2)}</strong>
            </div>
            <div class="chat-fact">
              <span class="chat-fact-label">Average score</span>
              <strong>${averageMetric('score').toFixed(2)}</strong>
            </div>
          </div>

          <div class="chat-helper-card">
            <div class="chat-helper-title">Try asking</div>
            <ul class="chat-helper-list">
              <li>Which step is the bottleneck and why?</li>
              <li>What is the average failure rate?</li>
              <li>Show the top 3 risky stages.</li>
              <li>Compare each step by processing time.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  `;
}

function renderChatMessage(message) {
  if (message.kind === 'loading') {
    return `
      <article class="chat-message chat-message-assistant">
        <div class="chat-avatar">AI</div>
        <div class="chat-bubble chat-bubble-loading">
          <div class="chat-message-role">WeakLink AI</div>
          <div class="chat-loading-dots" aria-label="AI is thinking">
            <span></span><span></span><span></span>
          </div>
        </div>
      </article>
    `;
  }

  return `
    <article class="chat-message chat-message-${message.role}">
      <div class="chat-avatar">${message.role === 'assistant' ? 'AI' : 'You'}</div>
      <div class="chat-bubble">
        <div class="chat-message-role">${message.role === 'assistant' ? 'WeakLink AI' : 'You'}</div>
        <p>${message.text}</p>
      </div>
    </article>
  `;
}

function seedChat() {
  state.chatMessages = [{
    role: 'assistant',
    text: `I am ready to analyze your loaded dataset. Right now, ${state.analysisResult.bottleneck.step} is the main bottleneck based on averaged process performance across ${state.analysisResult.sourceRowCount} uploaded records. Ask me about trends, averages, risky stages, totals, or comparisons.`,
  }];
}

function getSuggestedQuestions() {
  return [
    'Which step is the bottleneck and why?',
    'What is the average processing time?',
    'Show the top 3 risky stages.',
    'Which step has the highest failure rate?',
  ];
}

async function askAiChat(question) {
  const cleanQuestion = question.trim();
  if (!cleanQuestion || state.isChatLoading) return;

  state.chatMessages.push({ role: 'user', text: cleanQuestion });
  state.isChatLoading = true;
  state.chatMessages.push({ role: 'assistant', kind: 'loading', text: '' });
  renderCurrentPage();
  scrollChatToBottom();

  try {
    const answer = await askBackendQuestion(cleanQuestion);
    state.chatMessages = state.chatMessages.filter(message => message.kind !== 'loading');
    state.chatMessages.push({ role: 'assistant', text: answer });
  } catch (err) {
    console.error('LLM backend unavailable, using local fallback.', err);
    state.chatMessages = state.chatMessages.filter(message => message.kind !== 'loading');
    state.chatMessages.push({ role: 'assistant', text: answerDataQuestion(cleanQuestion) });
    showToast('LLM backend unavailable - using local analysis mode', 'warning');
  } finally {
    state.isChatLoading = false;
  }

  renderCurrentPage();
  scrollChatToBottom();
}

async function askBackendQuestion(question) {
  if (!state.analysisResult) {
    throw new Error('No analysis available');
  }

  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      question,
      analysis: buildChatAnalysisPayload(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result?.answer) {
    throw new Error('Missing answer from backend');
  }

  return result.answer;
}

function buildChatAnalysisPayload() {
  const processesByRisk = [...state.analysisResult.data].sort((a, b) => b.score - a.score);
  const processesByTime = [...state.analysisResult.data].sort((a, b) => b.time - a.time);

  return {
    bottleneck: {
      step: state.analysisResult.bottleneck.step,
      time: Number(state.analysisResult.bottleneck.time.toFixed(4)),
      failure: Number(state.analysisResult.bottleneck.failure.toFixed(4)),
      dependency: Number(state.analysisResult.bottleneck.dependency.toFixed(4)),
      score: Number(state.analysisResult.bottleneck.score.toFixed(4)),
      sampleSize: state.analysisResult.bottleneck.sampleSize,
      peopleCount: state.analysisResult.bottleneck.peopleCount,
    },
    explanation: state.analysisResult.explanation,
    avgTime: Number(state.analysisResult.avgTime.toFixed(4)),
    avgFailure: Number(state.analysisResult.avgFailure.toFixed(4)),
    avgDependency: Number(state.analysisResult.avgDep.toFixed(4)),
    sourceRowCount: state.analysisResult.sourceRowCount,
    processCount: state.analysisResult.processCount,
    topRiskProcesses: processesByRisk.slice(0, 5).map(item => ({
      step: item.step,
      time: Number(item.time.toFixed(4)),
      failure: Number(item.failure.toFixed(4)),
      dependency: Number(item.dependency.toFixed(4)),
      score: Number(item.score.toFixed(4)),
      sampleSize: item.sampleSize,
      peopleCount: item.peopleCount,
    })),
    slowestProcesses: processesByTime.slice(0, 5).map(item => ({
      step: item.step,
      time: Number(item.time.toFixed(4)),
      score: Number(item.score.toFixed(4)),
      sampleSize: item.sampleSize,
    })),
  };
}

async function persistAnalysisSnapshot() {
  if (!state.analysisResult) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/analysis-snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        analysis: buildChatAnalysisPayload(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    const result = await response.json();
    state.comparisonSummary = result.comparison || null;
  } catch (err) {
    console.error('Comparison persistence unavailable.', err);
    state.comparisonSummary = null;
    showToast('Supabase comparison unavailable - analysis not stored', 'warning');
  }
}

function answerDataQuestion(question) {
  if (!state.analysisResult) {
    return 'Load a CSV file or Google Sheet first so I can analyze the data.';
  }

  const q = normalizeQuestion(question);
  const { data, bottleneck, explanation, avgTime, avgFailure, avgDep } = state.analysisResult;
  const sortedByScore = [...data].sort((a, b) => b.score - a.score);
  const sortedByTime = [...data].sort((a, b) => b.time - a.time);
  const sortedByFailure = [...data].sort((a, b) => b.failure - a.failure);
  const sortedByDependency = [...data].sort((a, b) => b.dependency - a.dependency);

  if (
    (q.includes('how many') || q.includes('count') || q.includes('number of')) &&
    (q.includes('process') || q.includes('processes') || q.includes('stage') || q.includes('stages') || q.includes('row') || q.includes('rows') || q.includes('uploaded') || q.includes('loaded'))
  ) {
    return `There are ${state.analysisResult.processCount} averaged processes based on ${state.analysisResult.sourceRowCount} uploaded records in the current dataset.`;
  }

  if (q.includes('bottleneck') || q.includes('weakest') || q.includes('critical')) {
    return `${bottleneck.step} is the main bottleneck ${explanation}. Its score is ${bottleneck.score.toFixed(2)}, with time ${bottleneck.time}, failure ${bottleneck.failure}, and dependency ${bottleneck.dependency}.`;
  }

  if (q.includes('top 3') || q.includes('top three') || q.includes('risky') || q.includes('highest score')) {
    return `The top risk stages by bottleneck score are ${sortedByScore.slice(0, 3).map((item, index) => `${index + 1}. ${item.step} (${item.score.toFixed(2)})`).join(', ')}.`;
  }

  if (q.includes('average') && q.includes('time')) {
    return `The average processing time is ${avgTime.toFixed(2)} across ${data.length} stages. The highest-time stage is ${sortedByTime[0].step} at ${sortedByTime[0].time}.`;
  }

  if (q.includes('average') && (q.includes('failure') || q.includes('fail'))) {
    return `The average failure rate is ${avgFailure.toFixed(2)}. The highest failure rate is in ${sortedByFailure[0].step} at ${sortedByFailure[0].failure}.`;
  }

  if (q.includes('average') && q.includes('dependency')) {
    return `The average dependency impact is ${avgDep.toFixed(2)}. The most dependency-heavy stage is ${sortedByDependency[0].step} at ${sortedByDependency[0].dependency}.`;
  }

  if (q.includes('total') && q.includes('time')) {
    return `The total process time across all stages is ${sumMetric('time').toFixed(2)}.`;
  }

  if ((q.includes('highest') || q.includes('max')) && q.includes('failure')) {
    return `${sortedByFailure[0].step} has the highest failure rate at ${sortedByFailure[0].failure}.`;
  }

  if ((q.includes('highest') || q.includes('max')) && q.includes('time')) {
    return `${sortedByTime[0].step} takes the longest time at ${sortedByTime[0].time}.`;
  }

  if ((q.includes('highest') || q.includes('max')) && q.includes('dependency')) {
    return `${sortedByDependency[0].step} has the highest dependency impact at ${sortedByDependency[0].dependency}.`;
  }

  if (q.includes('compare') || q.includes('all steps') || q.includes('each step')) {
    return data.map(item => `${item.step}: time ${item.time}, failure ${item.failure}, dependency ${item.dependency}, score ${item.score.toFixed(2)}`).join(' | ');
  }

  return `I can answer questions from the loaded dataset. Try asking about the bottleneck, averages, totals, the highest time or failure stage, or the top risky steps. Current bottleneck: ${bottleneck.step}.`;
}

function sumMetric(metric) {
  return state.analysisResult.data.reduce((sum, item) => sum + item[metric], 0);
}

function averageMetric(metric) {
  return sumMetric(metric) / state.analysisResult.data.length;
}

function normalizeQuestion(question) {
  return question
    .toLowerCase()
    .replace(/proccess/g, 'process')
    .replace(/proceses/g, 'processes')
    .replace(/stpes/g, 'stages')
    .replace(/uploaded data/g, 'loaded data')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeAttribute(value) {
  return value.replace(/"/g, '&quot;');
}

function scrollChatToBottom() {
  const thread = document.getElementById('chatThread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function getRecommendationInsights() {
  const { data, bottleneck, avgTime, avgFailure, avgDep } = state.analysisResult;
  const recs = [];
  const secondHighest = [...data].sort((a, b) => b.score - a.score)[1];
  const bottleneckSpread = secondHighest ? bottleneck.score - secondHighest.score : bottleneck.score;

  if (bottleneck.time > avgTime) {
    recs.push({
      icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
      title: `Reduce cycle time in ${bottleneck.step}`,
      desc: `Average time in <strong>${bottleneck.step}</strong> is <strong>${bottleneck.time.toFixed(2)}</strong> versus a workflow average of <strong>${avgTime.toFixed(2)}</strong>. This suggests throughput is being held back by execution speed in this process.`,
      action: 'Automate repetitive checks, rebalance staffing at peak hours, and break the process into smaller parallelizable tasks.',
      impact: 'Expected impact: faster end-to-end completion time and lower queue buildup.',
      priority: 'high',
    });
  }

  if (bottleneck.failure > avgFailure) {
    recs.push({
      icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      title: `Lower rework and failure in ${bottleneck.step}`,
      desc: `Failure level in <strong>${bottleneck.step}</strong> is <strong>${bottleneck.failure.toFixed(2)}</strong> compared with an average of <strong>${avgFailure.toFixed(2)}</strong>. The process is likely producing avoidable exceptions or quality defects.`,
      action: 'Add validation gates before this stage, tighten input quality, and measure the top 3 failure reasons for rapid correction.',
      impact: 'Expected impact: fewer failed handoffs and lower operational rework.',
      priority: 'high',
    });
  }

  if (bottleneck.dependency > avgDep) {
    recs.push({
      icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
      title: `Reduce dependency load around ${bottleneck.step}`,
      desc: `Dependency pressure in <strong>${bottleneck.step}</strong> is <strong>${bottleneck.dependency.toFixed(2)}</strong> against an average of <strong>${avgDep.toFixed(2)}</strong>. Upstream reliance is increasing delay and fragility.`,
      action: 'Identify prerequisite steps, remove non-critical handoffs, and pre-stage required information before this process starts.',
      impact: 'Expected impact: smoother execution with fewer blocking waits.',
      priority: 'medium',
    });
  }

  recs.push({
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>`,
    title: 'Monitor the score gap between the top two processes',
    desc: secondHighest
      ? `The gap between <strong>${bottleneck.step}</strong> and the next riskiest process <strong>${secondHighest.step}</strong> is <strong>${bottleneckSpread.toFixed(2)}</strong>.`
      : `Only one process is available, so the current bottleneck should be monitored after each upload.`,
    action: secondHighest && bottleneckSpread < 0.08
      ? 'Treat the top two processes as a joint improvement program because the risk is concentrated in more than one stage.'
      : 'Keep monitoring the leading bottleneck after each upload to confirm whether fixes are reducing its lead over the rest of the workflow.',
    impact: 'Expected impact: better prioritization of improvement effort and less risk of solving the wrong problem.',
    priority: bottleneckSpread < 0.08 ? 'high' : 'medium',
  });

  recs.push({
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`,
    title: 'Validate changes in Simulation before rollout',
    desc: 'Use the Simulation page to test target improvements before changing the live workflow.',
    action: 'Reduce time, failure, or dependency for the top bottleneck process and compare the resulting score against the current baseline.',
    impact: 'Expected impact: safer decision-making before operational rollout.',
    priority: 'low',
  });

  return recs;
}

function renderRecommendations(recs = getRecommendationInsights()) {
  return `
    <div class="recommendations-list">
      ${recs.map(r => `
        <div class="recommendation-card recommendation-${r.priority}">
          <div class="rec-icon">${r.icon}</div>
          <div class="rec-content">
            <div class="rec-title">${r.title}</div>
            <div class="rec-desc">${r.desc}</div>
            <div class="rec-action"><strong>Recommended action:</strong> ${r.action}</div>
            <div class="rec-impact"><strong>Why this matters:</strong> ${r.impact}</div>
          </div>
          <span class="badge rec-priority badge-${r.priority === 'high' ? 'danger' : r.priority === 'medium' ? 'warning' : 'primary'}">${r.priority}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// =====================================================
// SKELETON & EMPTY STATE
// =====================================================
function renderSkeletonLoader() {
  return `
    <div class="skeleton-page">
      <div class="skeleton skeleton-alert"></div>
      <div>
        <div class="skeleton skeleton-header" style="margin-bottom:var(--sp-4)"></div>
        <div class="skeleton skeleton-pipeline"></div>
      </div>
      <div class="skeleton-cards">
        ${[1,2,3,4].map(() => `<div class="skeleton skeleton-card"></div>`).join('')}
      </div>
    </div>
  `;
}

function renderEmptyState(title, desc, action = '') {
  return `
    <div class="empty-state">
      <div class="empty-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
      </div>
      <h3 class="empty-title">${title}</h3>
      <p class="empty-desc">${desc}</p>
      ${action ? `<div class="empty-action">${action}</div>` : ''}
    </div>
  `;
}

// =====================================================
// TOAST
// =====================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const id = `toast-${Date.now()}`;
  const icons = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>`,
    warning: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`,
    info:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="8"/><line x1="12" x2="12" y1="12" y2="16"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.id = id;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Dismiss" onclick="
      const t = document.getElementById('${id}');
      if(t){ t.classList.add('toast-exit'); setTimeout(()=>t.remove(), 300); }
    ">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
    </button>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }
  }, 4500);
}

// =====================================================
// HELPERS
// =====================================================
function getStatus(d, bottleneck, data) {
  if (d.score === bottleneck.score) return 'danger';
  if (d.score > bottleneck.score * 0.6) return 'warning';
  return 'healthy';
}

// Inline SVG icon helpers (avoid re-running Lucide for simple icons)
function clockIcon() {
  return `<svg class="metric-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
}
function xCircleIcon() {
  return `<svg class="metric-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>`;
}
function gitMergeIcon() {
  return `<svg class="metric-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`;
}
function iconSvg(name) {
  const icons = {
    upload: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
    play: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    'rotate-ccw': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    link: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    'refresh-cw': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
    send: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/></svg>`,
  };
  return icons[name] || '';
}

// =====================================================
// EVENT BINDING
// =====================================================
function bindGlobalEvents() {
  // Sidebar toggle (desktop collapse)
  document.getElementById('toggleSidebarBtn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    // update icon direction
    const icon = document.getElementById('collapseIcon');
    if (icon) {
      icon.style.transform = sidebar.classList.contains('collapsed') ? 'scaleX(-1)' : '';
    }
  });

  // Mobile menu
  document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('active');
  });

  // Close sidebar on overlay click
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('active');
  });

  // Navbar refresh
  document.getElementById('navRefreshBtn')?.addEventListener('click', () => {
    if (state.currentUrl) loadFromUrl(state.currentUrl);
  });
}

function bindPageEvents(page) {
  if (page === 'data') bindDataEvents();
  if (page === 'simulation') bindSimulationEvents();
  if (page === 'ai-chat') bindAiChatEvents();
}

function bindDataEvents() {
  const fileInput = document.getElementById('fileInput');
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) loadFromFile(file);
  });

  document.getElementById('loadFileBtn')?.addEventListener('click', () => {
    const file = document.getElementById('fileInput')?.files[0];
    if (file) loadFromFile(file);
    else showToast('Please select a CSV file first', 'warning');
  });

  document.getElementById('loadSheetBtn')?.addEventListener('click', () => {
    const url = document.getElementById('sheetUrlInput')?.value.trim();
    if (!url) return showToast('Please paste a valid Google Sheet CSV link', 'warning');
    state.currentUrl = url;
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
      if (state.currentUrl) loadFromUrl(state.currentUrl);
    }, 30000);
    loadFromUrl(url);
  });

  document.getElementById('dataRefreshBtn')?.addEventListener('click', () => {
    if (state.currentUrl) loadFromUrl(state.currentUrl);
  });

  // Drag & drop
  const dropZone = document.getElementById('fileDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith('.csv')) loadFromFile(file);
      else showToast('Please drop a valid .csv file', 'warning');
    });
  }
}

function bindSimulationEvents() {
  document.getElementById('runSimBtn')?.addEventListener('click', () => {
    const simData = state.analysisResult.data.map(d => {
      const time = document.querySelector(`.sim-time[data-step="${d.step}"]`);
      const failure = document.querySelector(`.sim-failure[data-step="${d.step}"]`);
      const dep = document.querySelector(`.sim-dependency[data-step="${d.step}"]`);
      return {
        ...d,
        time:       time       ? +time.value       : d.time,
        failure:    failure    ? +failure.value    : d.failure,
        dependency: dep        ? +dep.value        : d.dependency,
      };
    });
    analyzeAggregatedProcesses(simData, state.analysisResult.sourceRowCount);
    showToast('Simulation complete — results updated on Dashboard', 'success');
    navigateTo('dashboard');
  });

  document.getElementById('resetSimBtn')?.addEventListener('click', () => {
    analyze(state.data);
    renderPage('simulation');
    showToast('Parameters reset to original values', 'info');
  });
}
function bindAiChatEvents() {
  document.getElementById('aiChatForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('aiChatInput');
    const question = input?.value.trim();
    if (!question) {
      showToast('Type a question for the AI chat first', 'warning');
      return;
    }
    input.value = '';
    await askAiChat(question);
  });

  document.querySelectorAll('[data-chat-question]').forEach(button => {
    button.addEventListener('click', async () => {
      await askAiChat(button.dataset.chatQuestion || '');
    });
  });

  document.getElementById('clearChatBtn')?.addEventListener('click', () => {
    seedChat();
    renderCurrentPage();
    scrollChatToBottom();
  });

  scrollChatToBottom();
}

// =====================================================
// INIT
// =====================================================
bindGlobalEvents();
window.addEventListener('hashchange', router);
router();

