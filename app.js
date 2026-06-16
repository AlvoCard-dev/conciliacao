"use strict";

const STORAGE_EXTRATO = "alvo_card_extrato_v1";
const STORAGE_RETORNO = "alvo_card_retorno_v1";
const STORAGE_SESSION = "alvo_card_session_v1";

/* ---------------- Supabase ---------------- */

const SUPABASE_URL = "https://xobtvogansqhwledysq.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvYnR2b2dhbnNscWh3bGVkeXNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1OTUyMjEsImV4cCI6MjA5NzE3MTIyMX0.E0kES6d1-jr3yxWFC4ZsE8MQ7ttOR5dOHovJiZtjXkA";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function sbSave(key, value) {
  const { error } = await sb
    .from("app_state")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

async function sbLoad(key) {
  const { data, error } = await sb
    .from("app_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) { console.error("Supabase load error:", key, error.message); return null; }
  console.log("Supabase load:", key, data ? "found" : "null");
  return data?.value ?? null;
}

async function sbDelete(key) {
  const { error } = await sb.from("app_state").delete().eq("key", key);
  if (error) console.error("Supabase delete error:", error.message);
}

const USERS = {
  Master: { password: "Upl@conc26", role: "master", label: "Master" },
  AlvoCard: { password: "@Conc2026", role: "viewer", label: "AlvoCard" },
};

let extratoData = null; // { convCol: string, rows: [{conv, data, mesAno, valorD, valorC}] }
let retornoData = null; // { rows: [{convenio, competencia, valor}] }

const TOLERANCIA = 0.01;

const MESES_PT = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

const CHART_COLORS = {
  accent: "#6366f1",
  accentLight: "#818cf8",
  success: "#10b981",
  successLight: "#34d399",
  teal: "#0d9488",
  warning: "#f59e0b",
  warningLight: "#fb923c",
  danger: "#ef4444",
  textDim: "#94a3b8",
  grid: "rgba(148,163,184,.12)",
};

if (typeof Chart !== "undefined") {
  Chart.defaults.color = CHART_COLORS.textDim;
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.borderColor = CHART_COLORS.grid;
}

let chartCreditoDebito = null;
let chartTopConvenios = null;
let chartEvolucao = null;
let chartConciliacaoStatus = null;
let chartConciliacaoComparativo = null;
let chartHomeConciliacaoStatus = null;

/* ---------------- Helpers ---------------- */

function normalizeNome(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// "abr/26" -> "04/2026"
function competenciaParaMesAno(competencia) {
  if (!competencia) return null;
  const partes = String(competencia).trim().toLowerCase().split("/");
  if (partes.length !== 2) return null;

  const mesStr = partes[0].trim();
  let mes;
  if (/^\d+$/.test(mesStr)) {
    mes = parseInt(mesStr, 10);
    if (mes < 1 || mes > 12) return null;
  } else {
    mes = MESES_PT[mesStr.slice(0, 3)];
    if (!mes) return null;
  }

  let ano = partes[1].trim();
  if (ano.length === 2) ano = (ano >= "70" ? "19" : "20") + ano;
  if (ano.length !== 4) return null;

  return `${String(mes).padStart(2, "0")}/${ano}`;
}

function moeda(v) {
  const n = Number(v) || 0;
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moedaCompacta(v) {
  const n = Number(v) || 0;
  const sinal = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const formatar = (valor, sufixo) => {
    const arredondado = Math.round(valor * 10) / 10;
    const texto = Number.isInteger(arredondado) ? arredondado.toFixed(0) : arredondado.toFixed(1);
    return `${sinal}${texto.replace(".", ",")}${sufixo}`;
  };
  if (abs >= 1e9) return formatar(abs / 1e9, "B");
  if (abs >= 1e6) return formatar(abs / 1e6, "M");
  if (abs >= 1e3) return formatar(abs / 1e3, "K");
  return `${sinal}${abs.toLocaleString("pt-BR")}`;
}

function parseNumeroBR(v) {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/[^\d,.-]/g, "");
  s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ""))].sort((a, b) =>
    String(a).localeCompare(String(b), "pt-BR")
  );
}

function fillSelect(select, options, placeholder) {
  const current = select.value;
  select.innerHTML = "";
  const optEl = document.createElement("option");
  optEl.value = "";
  optEl.textContent = placeholder;
  select.appendChild(optEl);
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt;
    el.textContent = opt;
    select.appendChild(el);
  }
  if (options.includes(current)) select.value = current;
}

/* ---------------- Navigation ---------------- */

function setupNavigation() {
  const links = document.querySelectorAll(".nav-link[data-page]");
  links.forEach((link) => {
    link.addEventListener("click", () => navigateTo(link.dataset.page));
  });

  document.getElementById("home-cta-btn").addEventListener("click", () => navigateTo("importar"));
}

function navigateTo(page) {
  document.querySelectorAll(".nav-link[data-page]").forEach((l) => {
    l.classList.toggle("active", l.dataset.page === page);
  });

  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById("page-" + page).classList.add("active");

  closeMobileNav();
  document.querySelector(".content").scrollTo?.({ top: 0 });
  window.scrollTo(0, 0);
}

function setupMobileNav() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const toggle = document.getElementById("topbar-toggle");

  toggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("show");
  });

  overlay.addEventListener("click", closeMobileNav);
}

function closeMobileNav() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebar-overlay").classList.remove("show");
}

/* ---------------- Toasts & Loading ---------------- */

function showLoading(text) {
  const overlay = document.getElementById("loading-overlay");
  document.getElementById("loading-text").textContent = text || "Processando...";
  overlay.hidden = false;
}

function hideLoading() {
  document.getElementById("loading-overlay").hidden = true;
}

const TOAST_ICONS = { success: "✅", error: "⚠️", info: "ℹ️" };

function showToast(message, type = "info", duration = 4000) {
  const container = document.getElementById("toast-container");

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-hide");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

/* ---------------- Extrato (xlsx) ---------------- */

async function handleExtratoFile(file) {
  showLoading("Importando extrato...");

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: null });

    if (!json.length) {
      showToast("O arquivo de extrato está vazio.", "error");
      return;
    }

    const headers = Object.keys(json[0]);

    const dataCol = headers.find((h) => h.toLowerCase().includes("data") && h.toLowerCase().includes("mov"));
    const convCol = headers.find((h) => h.toLowerCase().includes("conv"));
    const valorCol = headers.find((h) => h.trim().toLowerCase() === "valor");
    const naturezaCol = headers.find((h) => h.toLowerCase().includes("natureza"));

    const rows = json.map((r) => {
      let data = r[dataCol];
      if (!(data instanceof Date)) data = new Date(data);

      const valido = !isNaN(data.getTime());
      const valor = parseNumeroBR(r[valorCol]);
      const natureza = String(r[naturezaCol] || "").trim().toUpperCase();

      let mesAno = "";
      if (valido) {
        const mm = String(data.getMonth() + 1).padStart(2, "0");
        mesAno = `${mm}/${data.getFullYear()}`;
      }

      const raw = {};
      for (const h of headers) {
        const v = r[h];
        raw[h] = v instanceof Date ? v.toISOString() : v;
      }

      return {
        conv: r[convCol],
        data: valido ? data.toISOString() : null,
        mesAno,
        valorD: natureza === "D" ? valor : 0,
        valorC: natureza === "C" ? valor : 0,
        raw,
      };
    });

    extratoData = { convCol, dataCol, headers, rows, importadoEm: new Date().toISOString() };
    localStorage.setItem(STORAGE_EXTRATO, JSON.stringify(extratoData));
    // Salva versão sem "raw" no Supabase para reduzir tamanho
    const extratoCompacto = { ...extratoData, rows: rows.map(({ raw, ...r }) => r) };
    sbSave("extrato", extratoCompacto)
      .then(() => showToast("Extrato sincronizado com servidor ✓", "success", 3000))
      .catch((err) => { console.error(err); showToast("Erro ao sincronizar extrato: " + err.message, "error", 6000); });

    document.getElementById("extrato-filename").textContent = `✅ ${file.name}`;
    document.querySelector('label[for="input-extrato"]').classList.add("loaded");

    renderAll();
    showToast(`Extrato importado: ${rows.length} lançamentos.`, "success");
  } catch (err) {
    console.error("Erro ao importar extrato:", err);
    showToast("Erro ao importar o extrato. Verifique o arquivo.", "error");
  } finally {
    hideLoading();
  }
}

/* ---------------- Retorno (csv) ---------------- */

async function handleRetornoFile(file) {
  showLoading("Importando arquivo retorno...");

  try {
    const buf = await file.arrayBuffer();
    const text = new TextDecoder("windows-1252").decode(buf);

    const parsed = Papa.parse(text, {
      header: true,
      delimiter: ";",
      skipEmptyLines: true,
    });

    if (!parsed.data.length) {
      showToast("O arquivo de retorno está vazio.", "error");
      return;
    }

    const rows = parsed.data.map((r) => ({
      convenio: r["convenio"],
      competencia: r["competencia"],
      valor: parseNumeroBR(r["total_valor_descontado"]),
    }));

    retornoData = { rows, importadoEm: new Date().toISOString() };
    localStorage.setItem(STORAGE_RETORNO, JSON.stringify(retornoData));
    sbSave("retorno", retornoData)
      .then(() => showToast("Retorno sincronizado com servidor ✓", "success", 3000))
      .catch((err) => { console.error(err); showToast("Erro ao sincronizar retorno: " + err.message, "error", 6000); });

    document.getElementById("retorno-filename").textContent = `✅ ${file.name}`;
    document.querySelector('label[for="input-retorno"]').classList.add("loaded");

    renderAll();
    showToast(`Arquivo retorno importado: ${rows.length} registros.`, "success");
  } catch (err) {
    console.error("Erro ao importar retorno:", err);
    showToast("Erro ao importar o arquivo de retorno. Verifique o arquivo.", "error");
  } finally {
    hideLoading();
  }
}

/* ---------------- Render: Home ---------------- */

function renderHome() {
  let totalC = 0;
  let totalD = 0;
  let conv = 0;

  if (extratoData) {
    const { rows } = extratoData;
    totalC = rows.reduce((acc, r) => acc + r.valorC, 0);
    totalD = rows.reduce((acc, r) => acc + r.valorD, 0);
    conv = uniqueSorted(rows.map((r) => r.conv)).length;
  }

  document.getElementById("home-total-c").textContent = moeda(totalC);
  document.getElementById("home-total-d").textContent = moeda(totalD);
  document.getElementById("home-saldo").textContent = moeda(totalC - totalD);
  document.getElementById("home-conv").textContent = conv;

  const dados = computeConciliacao();
  const cruzados = dados.filter((r) => r.status in STATUS_DONUT_COLORS);
  const conciliados = cruzados.filter((r) => r.status !== "divergente").length;
  const taxa = cruzados.length ? Math.round((conciliados / cruzados.length) * 100) : 0;
  document.getElementById("home-taxa-conciliacao").textContent = `${taxa}%`;

  const pendencias = dados.filter((r) => r.status !== "ok" && r.status !== "conciliado-maior" && r.status !== "conciliado-menor").length;
  document.getElementById("home-pendencias").textContent = pendencias;

  const hasData = !!(extratoData && extratoData.rows.length) || !!(retornoData && retornoData.rows.length);
  document.getElementById("home-cta").hidden = hasData;

  const datas = [extratoData?.importadoEm, retornoData?.importadoEm].filter(Boolean).map((d) => new Date(d));
  const meta = document.getElementById("home-last-update");
  if (datas.length) {
    const ultima = new Date(Math.max(...datas.map((d) => d.getTime())));
    meta.textContent = `Atualizado em ${ultima.toLocaleDateString("pt-BR")} às ${ultima.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  } else {
    meta.textContent = "";
  }

  const hora = new Date().getHours();
  const saudacao = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
  const session = getSession();
  document.getElementById("home-greeting").textContent = `${saudacao}${session ? ", " + session.label : ""} · ${new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}`;


  renderChartCreditoDebito(totalC, totalD);
  renderChartTopConvenios();
  renderChartHomeConciliacaoStatus(dados);
  renderHomeDivergencias(dados);
}

function renderHomeDivergencias(dados) {
  const tbody = document.getElementById("home-divergencias-tbody");
  const empty = document.getElementById("home-divergencias-empty");
  const table = document.getElementById("home-divergencias-table");

  tbody.innerHTML = "";

  const top = dados
    .filter((r) => r.status === "divergente")
    .sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca))
    .slice(0, 5);

  if (!top.length) {
    table.hidden = true;
    empty.hidden = false;
    return;
  }

  table.hidden = false;
  empty.hidden = true;

  for (const r of top) {
    const status = STATUS_LABEL[r.status];
    const diffClass = r.diferenca < 0 ? "text-danger" : "text-success";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.convenio}<br><span style="font-size:11px;color:var(--text-faint)">${r.mesAno}</span></td>
      <td class="${diffClass}" style="font-weight:700">${moeda(r.diferenca)}</td>
      <td><span class="badge ${status.className}">${status.label}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------- Charts: Home ---------------- */

function renderChartCreditoDebito(totalC, totalD) {
  const canvas = document.getElementById("chart-credito-debito");
  const empty = document.getElementById("chart-credito-debito-empty");

  if (chartCreditoDebito) {
    chartCreditoDebito.destroy();
    chartCreditoDebito = null;
  }

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Biblioteca de gráficos indisponível.";
    return;
  }

  if (!extratoData || !extratoData.rows.length || (totalC === 0 && totalD === 0)) {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Sem dados do extrato.";
    return;
  }

  canvas.style.display = "";
  empty.hidden = true;

  chartCreditoDebito = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Crédito", "Débito"],
      datasets: [
        {
          data: [totalC, totalD],
          backgroundColor: [CHART_COLORS.success, CHART_COLORS.danger],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${moeda(ctx.raw)}` } },
      },
    },
  });
}

function renderChartTopConvenios() {
  const canvas = document.getElementById("chart-top-convenios");
  const empty = document.getElementById("chart-top-convenios-empty");

  if (chartTopConvenios) {
    chartTopConvenios.destroy();
    chartTopConvenios = null;
  }

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Biblioteca de gráficos indisponível.";
    return;
  }

  if (!extratoData || !extratoData.rows.length) {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Sem dados do extrato.";
    return;
  }

  const grupos = new Map();
  for (const r of extratoData.rows) {
    const chave = r.conv ?? "—";
    grupos.set(chave, (grupos.get(chave) || 0) + r.valorC - r.valorD);
  }

  const top = [...grupos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  canvas.style.display = "";
  empty.hidden = true;

  chartTopConvenios = new Chart(canvas, {
    type: "bar",
    data: {
      labels: top.map(([conv]) => conv),
      datasets: [
        {
          label: "Saldo",
          data: top.map(([, v]) => v),
          backgroundColor: CHART_COLORS.accent,
          borderRadius: 6,
          maxBarThickness: 32,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => moeda(ctx.raw) } },
      },
      scales: {
        x: { ticks: { callback: (v) => moedaCompacta(v) }, grid: { display: false } },
        y: { grid: { display: false } },
      },
    },
  });
}

/* ---------------- Render: Ranking ---------------- */

function renderRanking() {
  const tbody = document.getElementById("ranking-tbody");
  const empty = document.getElementById("ranking-empty");
  const select = document.getElementById("ranking-convenio");

  tbody.innerHTML = "";

  if (!extratoData || !extratoData.rows.length) {
    empty.hidden = false;
    fillSelect(select, [], "Todos Convênios");
    return;
  }

  empty.hidden = true;

  const { rows } = extratoData;
  fillSelect(select, uniqueSorted(rows.map((r) => r.conv)), "Todos Convênios");

  const filtro = select.value;
  const filtered = filtro ? rows.filter((r) => r.conv === filtro) : rows;

  const grupos = new Map();
  for (const r of filtered) {
    const chave = r.conv ?? "—";
    if (!grupos.has(chave)) grupos.set(chave, { valorD: 0, valorC: 0 });
    const g = grupos.get(chave);
    g.valorD += r.valorD;
    g.valorC += r.valorC;
  }

  const ordenados = [...grupos.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "pt-BR"));

  let totalD = 0;
  let totalC = 0;

  for (const [conv, g] of ordenados) {
    const saldo = g.valorC - g.valorD;
    totalD += g.valorD;
    totalC += g.valorC;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${conv}</td>
      <td>${moeda(g.valorD)}</td>
      <td>${moeda(g.valorC)}</td>
      <td>${moeda(saldo)}</td>
    `;
    tbody.appendChild(tr);
  }

  if (ordenados.length > 1) {
    const tr = document.createElement("tr");
    tr.className = "total-row";
    tr.innerHTML = `
      <td>TOTAL</td>
      <td>${moeda(totalD)}</td>
      <td>${moeda(totalC)}</td>
      <td>${moeda(totalC - totalD)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------- Render: Evolução ---------------- */

function renderEvolucao() {
  const tbody = document.getElementById("evolucao-tbody");
  const empty = document.getElementById("evolucao-empty");
  const selectConv = document.getElementById("evolucao-convenio");
  const inputInicio = document.getElementById("evolucao-inicio");
  const inputFim = document.getElementById("evolucao-fim");

  tbody.innerHTML = "";

  if (!extratoData || !extratoData.rows.length) {
    empty.hidden = false;
    fillSelect(selectConv, [], "Todos Convênios");
    renderChartEvolucao([]);
    return;
  }

  empty.hidden = true;

  const { rows } = extratoData;
  fillSelect(selectConv, uniqueSorted(rows.map((r) => r.conv)), "Todos Convênios");

  const filtroConv = selectConv.value;
  const inicio = inputInicio.value ? new Date(inputInicio.value + "T00:00:00") : null;
  const fim = inputFim.value ? new Date(inputFim.value + "T23:59:59") : null;

  const filtered = rows.filter((r) => {
    if (filtroConv && r.conv !== filtroConv) return false;
    if (r.data) {
      const d = new Date(r.data);
      if (inicio && d < inicio) return false;
      if (fim && d > fim) return false;
    } else if (inicio || fim) {
      return false;
    }
    return true;
  });

  renderChartEvolucao(filtered);

  const grupos = new Map();
  for (const r of filtered) {
    const chave = `${r.conv ?? "—"}__${r.mesAno}`;
    if (!grupos.has(chave)) grupos.set(chave, { conv: r.conv ?? "—", mesAno: r.mesAno, valorD: 0, valorC: 0 });
    const g = grupos.get(chave);
    g.valorD += r.valorD;
    g.valorC += r.valorC;
  }

  const ordenados = [...grupos.values()].sort((a, b) => {
    const convCompare = String(a.conv).localeCompare(String(b.conv), "pt-BR");
    if (convCompare !== 0) return convCompare;
    return mesAnoParaOrdenacao(a.mesAno) - mesAnoParaOrdenacao(b.mesAno);
  });

  for (const g of ordenados) {
    const saldo = g.valorC - g.valorD;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${g.conv}</td>
      <td>${g.mesAno || "—"}</td>
      <td>${moeda(g.valorD)}</td>
      <td>${moeda(g.valorC)}</td>
      <td>${moeda(saldo)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function mesAnoParaOrdenacao(mesAno) {
  if (!mesAno) return 0;
  const [mes, ano] = mesAno.split("/");
  return Number(ano) * 100 + Number(mes);
}

/* ---------------- Chart: Evolução ---------------- */

function renderChartEvolucao(filtered) {
  const canvas = document.getElementById("chart-evolucao");
  const empty = document.getElementById("chart-evolucao-empty");

  if (chartEvolucao) {
    chartEvolucao.destroy();
    chartEvolucao = null;
  }

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Biblioteca de gráficos indisponível.";
    return;
  }

  const grupos = new Map();
  for (const r of filtered) {
    if (!r.mesAno) continue;
    if (!grupos.has(r.mesAno)) grupos.set(r.mesAno, { valorD: 0, valorC: 0 });
    const g = grupos.get(r.mesAno);
    g.valorD += r.valorD;
    g.valorC += r.valorC;
  }

  const meses = [...grupos.keys()].sort((a, b) => mesAnoParaOrdenacao(a) - mesAnoParaOrdenacao(b));

  if (!meses.length) {
    canvas.style.display = "none";
    empty.hidden = false;
    return;
  }

  canvas.style.display = "";
  empty.hidden = true;

  const dataC = meses.map((m) => grupos.get(m).valorC);
  const dataD = meses.map((m) => grupos.get(m).valorD);
  const dataSaldo = meses.map((m) => grupos.get(m).valorC - grupos.get(m).valorD);

  chartEvolucao = new Chart(canvas, {
    data: {
      labels: meses,
      datasets: [
        { type: "bar", label: "Crédito", data: dataC, backgroundColor: CHART_COLORS.success, borderRadius: 4, maxBarThickness: 36 },
        { type: "bar", label: "Débito", data: dataD, backgroundColor: CHART_COLORS.danger, borderRadius: 4, maxBarThickness: 36 },
        { type: "line", label: "Saldo", data: dataSaldo, borderColor: CHART_COLORS.accentLight, backgroundColor: CHART_COLORS.accentLight, tension: 0.3, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${moeda(ctx.raw)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: (v) => moedaCompacta(v) }, grid: { display: false } },
      },
    },
  });
}

/* ---------------- Render: Retorno ---------------- */

function renderRetorno() {
  const tbody = document.getElementById("retorno-tbody");
  const empty = document.getElementById("retorno-empty");
  const selectConv = document.getElementById("retorno-convenio");
  const selectComp = document.getElementById("retorno-competencia");

  tbody.innerHTML = "";

  if (!retornoData || !retornoData.rows.length) {
    empty.hidden = false;
    fillSelect(selectConv, [], "Todos Convênios");
    fillSelect(selectComp, [], "Todas Competências");
    return;
  }

  empty.hidden = true;

  const { rows } = retornoData;
  fillSelect(selectConv, uniqueSorted(rows.map((r) => r.convenio)), "Todos Convênios");
  fillSelect(selectComp, uniqueSorted(rows.map((r) => r.competencia)), "Todas Competências");

  const filtroConv = selectConv.value;
  const filtroComp = selectComp.value;

  const filtered = rows.filter((r) => {
    if (filtroConv && r.convenio !== filtroConv) return false;
    if (filtroComp && r.competencia !== filtroComp) return false;
    return true;
  });

  let total = 0;

  for (const r of filtered) {
    total += r.valor;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.convenio ?? "—"}</td>
      <td>${r.competencia ?? "—"}</td>
      <td>${moeda(r.valor)}</td>
    `;
    tbody.appendChild(tr);
  }

  if (filtered.length > 1) {
    const tr = document.createElement("tr");
    tr.className = "total-row";
    tr.innerHTML = `
      <td colspan="2">TOTAL</td>
      <td>${moeda(total)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------- Conciliação ---------------- */

function computeConciliacao() {
  const map = new Map();

  if (extratoData) {
    for (const r of extratoData.rows) {
      if (!r.mesAno) continue;

      const key = `${normalizeNome(r.conv)}__${r.mesAno}`;
      if (!map.has(key)) {
        map.set(key, {
          convExtrato: r.conv,
          convRetorno: null,
          mesAno: r.mesAno,
          valorExtrato: 0,
          valorDebitoExtrato: 0,
          qtdLancamentosExtrato: 0,
          valorRetorno: 0,
        });
      }
      const item = map.get(key);
      item.valorExtrato += r.valorC;
      item.valorDebitoExtrato += r.valorD;
      item.qtdLancamentosExtrato += 1;
    }
  }

  if (retornoData) {
    for (const r of retornoData.rows) {
      const mesAno = competenciaParaMesAno(r.competencia);
      if (!mesAno) continue;

      const key = `${normalizeNome(r.convenio)}__${mesAno}`;
      if (!map.has(key)) {
        map.set(key, {
          convExtrato: null,
          convRetorno: r.convenio,
          mesAno,
          valorExtrato: 0,
          valorDebitoExtrato: 0,
          qtdLancamentosExtrato: 0,
          valorRetorno: 0,
        });
      }

      const item = map.get(key);
      if (!item.convRetorno) item.convRetorno = r.convenio;
      item.valorRetorno += r.valor;
    }
  }

  const resultado = [...map.values()].map((item) => {
    const convenio = item.convExtrato ?? item.convRetorno ?? "—";
    const diferenca = item.valorExtrato - item.valorRetorno;

    let status;
    if (item.convExtrato === null) status = "sem-extrato";
    else if (item.convRetorno === null) status = "sem-retorno";
    else if (Math.abs(diferenca) < TOLERANCIA) status = "ok";
    else if (item.valorRetorno !== 0 && Math.abs(diferenca) <= Math.abs(item.valorRetorno) * 0.05) {
      status = diferenca > 0 ? "conciliado-maior" : "conciliado-menor";
    } else status = "divergente";

    return {
      convenio,
      mesAno: item.mesAno,
      valorExtrato: item.valorExtrato,
      valorDebitoExtrato: item.valorDebitoExtrato,
      qtdLancamentosExtrato: item.qtdLancamentosExtrato,
      valorRetorno: item.valorRetorno,
      diferenca,
      status,
    };
  });

  resultado.sort((a, b) => {
    const convCompare = String(a.convenio).localeCompare(String(b.convenio), "pt-BR");
    if (convCompare !== 0) return convCompare;
    return mesAnoParaOrdenacao(a.mesAno) - mesAnoParaOrdenacao(b.mesAno);
  });

  return resultado;
}

const STATUS_LABEL = {
  ok: { label: "Conciliado", className: "badge-success" },
  "conciliado-maior": { label: "Conciliado a maior", className: "badge-success" },
  "conciliado-menor": { label: "Conciliado a menor", className: "badge-success" },
  divergente: { label: "Divergente", className: "badge-danger" },
  "sem-extrato": { label: "Sem Extrato", className: "badge-warning" },
  "sem-retorno": { label: "Sem Retorno", className: "badge-warning" },
};

function filtrarConciliacao(dados) {
  const filtroConv = document.getElementById("conciliacao-convenio").value;
  const filtroMes = document.getElementById("conciliacao-mes").value;
  const filtroStatus = document.getElementById("conciliacao-status").value;

  return dados.filter((r) => {
    if (filtroConv && r.convenio !== filtroConv) return false;
    if (filtroMes && r.mesAno !== filtroMes) return false;
    if (filtroStatus && r.status !== filtroStatus) return false;
    return true;
  });
}

function updateConciliacaoSummary(dados) {
  const contagem = { ok: 0, "conciliado-maior": 0, "conciliado-menor": 0, divergente: 0, "sem-extrato": 0, "sem-retorno": 0 };
  for (const r of dados) contagem[r.status]++;

  document.getElementById("conc-summary-ok").textContent = contagem.ok + contagem["conciliado-maior"] + contagem["conciliado-menor"];
  document.getElementById("conc-summary-divergente").textContent = contagem.divergente;
  document.getElementById("conc-summary-sem-retorno").textContent = contagem["sem-retorno"];
  document.getElementById("conc-summary-sem-extrato").textContent = contagem["sem-extrato"];
}

const STATUS_DONUT_COLORS = {
  ok: CHART_COLORS.success,
  "conciliado-maior": CHART_COLORS.successLight,
  "conciliado-menor": CHART_COLORS.teal,
  divergente: CHART_COLORS.danger,
};

function renderStatusDonut(canvasId, emptyId, dados, existingChart) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);

  if (existingChart) existingChart.destroy();

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Biblioteca de gráficos indisponível.";
    return null;
  }

  const cruzados = dados.filter((r) => r.status in STATUS_DONUT_COLORS);

  if (!cruzados.length) {
    canvas.style.display = "none";
    empty.hidden = false;
    return null;
  }

  const contagem = new Map();
  for (const r of cruzados) contagem.set(r.status, (contagem.get(r.status) || 0) + 1);

  const statusOrdenados = Object.keys(STATUS_DONUT_COLORS).filter((s) => contagem.has(s));
  const total = cruzados.length;

  canvas.style.display = "";
  empty.hidden = true;

  return new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: statusOrdenados.map((s) => STATUS_LABEL[s].label),
      datasets: [
        {
          data: statusOrdenados.map((s) => contagem.get(s)),
          backgroundColor: statusOrdenados.map((s) => STATUS_DONUT_COLORS[s]),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.raw} (${((ctx.raw / total) * 100).toFixed(0)}%)`,
          },
        },
      },
    },
  });
}

function renderChartConciliacaoStatus(dados) {
  chartConciliacaoStatus = renderStatusDonut("chart-conciliacao-status", "chart-conciliacao-status-empty", dados, chartConciliacaoStatus);
}

function renderChartHomeConciliacaoStatus(dados) {
  chartHomeConciliacaoStatus = renderStatusDonut("chart-home-conciliacao-status", "chart-home-conciliacao-status-empty", dados, chartHomeConciliacaoStatus);
}

function renderChartConciliacaoComparativo(filtered) {
  const canvas = document.getElementById("chart-conciliacao-comparativo");
  const empty = document.getElementById("chart-conciliacao-comparativo-empty");

  if (chartConciliacaoComparativo) {
    chartConciliacaoComparativo.destroy();
    chartConciliacaoComparativo = null;
  }

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    empty.hidden = false;
    empty.textContent = "Biblioteca de gráficos indisponível.";
    return;
  }

  const cruzados = filtered.filter((r) => r.valorRetorno !== 0 && r.valorExtrato !== 0);

  if (!cruzados.length) {
    canvas.style.display = "none";
    empty.hidden = false;
    return;
  }

  const LIMITE = 8;
  const top = [...cruzados]
    .sort((a, b) => (b.valorRetorno + b.valorExtrato) - (a.valorRetorno + a.valorExtrato))
    .slice(0, LIMITE)
    .reverse();

  canvas.style.display = "";
  empty.hidden = true;

  chartConciliacaoComparativo = new Chart(canvas, {
    type: "bar",
    data: {
      labels: top.map((r) => `${r.convenio} - ${r.mesAno}`),
      datasets: [
        { label: "Retorno", data: top.map((r) => r.valorRetorno), backgroundColor: CHART_COLORS.accent, borderRadius: 4, maxBarThickness: 16 },
        { label: "Extrato", data: top.map((r) => r.valorExtrato), backgroundColor: CHART_COLORS.success, borderRadius: 4, maxBarThickness: 16 },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${moeda(ctx.raw)}` } },
      },
      scales: {
        x: { ticks: { callback: (v) => moedaCompacta(v) }, grid: { display: false } },
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  });
}

function renderConciliacao() {
  const tbody = document.getElementById("conciliacao-tbody");
  const empty = document.getElementById("conciliacao-empty");
  const selectConv = document.getElementById("conciliacao-convenio");
  const selectMes = document.getElementById("conciliacao-mes");
  const selectStatus = document.getElementById("conciliacao-status");

  tbody.innerHTML = "";

  const dados = computeConciliacao();

  if (!dados.length) {
    empty.hidden = false;
    fillSelect(selectConv, [], "Todos Convênios");
    fillSelect(selectMes, [], "Todos os Meses");
    updateConciliacaoSummary(dados);
    renderChartConciliacaoStatus(dados);
    renderChartConciliacaoComparativo([]);
    return;
  }

  empty.hidden = true;

  fillSelect(selectConv, uniqueSorted(dados.map((r) => r.convenio)), "Todos Convênios");
  fillSelect(
    selectMes,
    [...new Set(dados.map((r) => r.mesAno))].sort((a, b) => mesAnoParaOrdenacao(a) - mesAnoParaOrdenacao(b)),
    "Todos os Meses"
  );

  const filtered = filtrarConciliacao(dados);

  let totalExtrato = 0;
  let totalRetorno = 0;

  for (const r of filtered) {
    totalExtrato += r.valorExtrato;
    totalRetorno += r.valorRetorno;

    const status = STATUS_LABEL[r.status];
    const diffClass = Math.abs(r.diferenca) < TOLERANCIA ? "text-dim" : r.diferenca < 0 ? "text-danger" : "text-success";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.convenio}</td>
      <td>${r.mesAno}</td>
      <td>${moeda(r.valorRetorno)}</td>
      <td>${moeda(r.valorExtrato)}</td>
      <td class="${diffClass}">${moeda(r.diferenca)}</td>
      <td><span class="badge ${status.className}">${status.label}</span></td>
    `;
    tbody.appendChild(tr);
  }

  if (filtered.length > 1) {
    const tr = document.createElement("tr");
    tr.className = "total-row";
    tr.innerHTML = `
      <td colspan="2">TOTAL</td>
      <td>${moeda(totalRetorno)}</td>
      <td>${moeda(totalExtrato)}</td>
      <td>${moeda(totalExtrato - totalRetorno)}</td>
      <td></td>
    `;
    tbody.appendChild(tr);
  }

  updateConciliacaoSummary(dados);
  renderChartConciliacaoStatus(dados);
  renderChartConciliacaoComparativo(filtered);
}

/* ---------------- Render: All ---------------- */

function safeRender(fn) {
  try {
    fn();
  } catch (err) {
    console.error(`Erro ao renderizar ${fn.name}:`, err);
  }
}

function renderAll() {
  safeRender(renderHome);
  safeRender(renderRanking);
  safeRender(renderEvolucao);
  safeRender(renderRetorno);
  safeRender(renderConciliacao);
  safeRender(updateStatusPills);
}

/* ---------------- Setup ---------------- */

function setupUploads() {
  const inputExtrato = document.getElementById("input-extrato");
  const inputRetorno = document.getElementById("input-retorno");

  inputExtrato.addEventListener("change", (e) => {
    if (e.target.files[0]) handleExtratoFile(e.target.files[0]);
  });

  inputRetorno.addEventListener("change", (e) => {
    if (e.target.files[0]) handleRetornoFile(e.target.files[0]);
  });

  setupDropzone("input-extrato", handleExtratoFile);
  setupDropzone("input-retorno", handleRetornoFile);
}

function setupDropzone(inputId, handler) {
  const input = document.getElementById(inputId);
  const label = document.querySelector(`label[for="${inputId}"]`);

  ["dragenter", "dragover"].forEach((evt) =>
    label.addEventListener(evt, (e) => {
      e.preventDefault();
      label.classList.add("dragover");
    })
  );

  ["dragleave", "drop"].forEach((evt) =>
    label.addEventListener(evt, (e) => {
      e.preventDefault();
      label.classList.remove("dragover");
    })
  );

  label.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      input.files = e.dataTransfer.files;
      handler(file);
    }
  });
}

function setupFilters() {
  document.getElementById("ranking-convenio").addEventListener("change", renderRanking);
  document.getElementById("evolucao-convenio").addEventListener("change", renderEvolucao);
  document.getElementById("evolucao-inicio").addEventListener("change", renderEvolucao);
  document.getElementById("evolucao-fim").addEventListener("change", renderEvolucao);
  document.getElementById("retorno-convenio").addEventListener("change", renderRetorno);
  document.getElementById("retorno-competencia").addEventListener("change", renderRetorno);
  document.getElementById("conciliacao-convenio").addEventListener("change", renderConciliacao);
  document.getElementById("conciliacao-mes").addEventListener("change", renderConciliacao);
  document.getElementById("conciliacao-status").addEventListener("change", renderConciliacao);
}

function updateStatusPills() {
  const pillExtrato = document.getElementById("status-extrato");
  const pillRetorno = document.getElementById("status-retorno");
  const cardExtrato = document.getElementById("import-status-extrato");
  const cardRetorno = document.getElementById("import-status-retorno");

  if (extratoData && extratoData.rows.length) {
    pillExtrato.classList.add("ok");
    pillExtrato.lastChild.textContent = ` Extrato: ${extratoData.rows.length} lançamentos`;
    cardExtrato.classList.add("ok");
    cardExtrato.querySelector("p").textContent = `${extratoData.rows.length} lançamentos importados`;
  } else {
    pillExtrato.classList.remove("ok");
    pillExtrato.lastChild.textContent = " Extrato não carregado";
    cardExtrato.classList.remove("ok");
    cardExtrato.querySelector("p").textContent = "Nenhum arquivo importado";
  }

  if (retornoData && retornoData.rows.length) {
    pillRetorno.classList.add("ok");
    pillRetorno.lastChild.textContent = ` Retorno: ${retornoData.rows.length} registros`;
    cardRetorno.classList.add("ok");
    cardRetorno.querySelector("p").textContent = `${retornoData.rows.length} registros importados`;
  } else {
    pillRetorno.classList.remove("ok");
    pillRetorno.lastChild.textContent = " Retorno não carregado";
    cardRetorno.classList.remove("ok");
    cardRetorno.querySelector("p").textContent = "Nenhum arquivo importado";
  }
}

/* ---------------- Export ---------------- */

function exportTableToExcel(tableId, filename) {
  const table = document.getElementById(tableId);
  const wb = XLSX.utils.table_to_book(table, { sheet: "Dados" });
  XLSX.writeFile(wb, filename);
  showToast(`Arquivo "${filename}" exportado.`, "success");
}

function exportConciliacaoExcel() {
  const filtered = filtrarConciliacao(computeConciliacao());

  if (!filtered.length) {
    showToast("Nenhum dado de conciliação para exportar.", "error");
    return;
  }

  const linhasConciliacao = filtered.map((r) => ({
    "Convênio": r.convenio,
    "Mês": r.mesAno,
    "Valor Retorno": r.valorRetorno,
    "Valor Extrato (Crédito)": r.valorExtrato,
    "Valor Extrato (Débito)": r.valorDebitoExtrato,
    "Saldo Extrato": r.valorExtrato - r.valorDebitoExtrato,
    "Qtd Lançamentos Extrato": r.qtdLancamentosExtrato,
    "Diferença": r.diferenca,
    "Status": STATUS_LABEL[r.status].label,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasConciliacao), "Conciliação");

  if (extratoData && extratoData.rows.length) {
    const { dataCol } = extratoData;

    const chaves = new Set(filtered.map((r) => `${normalizeNome(r.convenio)}__${r.mesAno}`));
    const linhasOrigem = extratoData.rows.filter((r) => chaves.has(`${normalizeNome(r.conv)}__${r.mesAno}`));

    const linhasExtrato = linhasOrigem.map((r) => {
      const linha = { ...r.raw, "Mês/Ano": r.mesAno };
      if (dataCol && linha[dataCol]) linha[dataCol] = new Date(linha[dataCol]);
      return linha;
    });

    if (linhasExtrato.length) {
      const wsExtrato = XLSX.utils.json_to_sheet(linhasExtrato, { dateNF: "dd/mm/yyyy" });
      XLSX.utils.book_append_sheet(wb, wsExtrato, "Extrato");
    }
  }

  XLSX.writeFile(wb, "conciliacao.xlsx");
  showToast('Arquivo "conciliacao.xlsx" exportado.', "success");
}

function setupExports() {
  document.getElementById("ranking-export").addEventListener("click", () =>
    exportTableToExcel("ranking-table", "ranking_extrato.xlsx")
  );
  document.getElementById("evolucao-export").addEventListener("click", () =>
    exportTableToExcel("evolucao-table", "evolucao_extrato.xlsx")
  );
  document.getElementById("retorno-export").addEventListener("click", () =>
    exportTableToExcel("retorno-table", "arquivo_retorno.xlsx")
  );
  document.getElementById("conciliacao-export").addEventListener("click", exportConciliacaoExcel);
}

function setupClear() {
  document.getElementById("btn-limpar").addEventListener("click", () => {
    if (!confirm("Remover todos os dados importados?")) return;

    localStorage.removeItem(STORAGE_EXTRATO);
    localStorage.removeItem(STORAGE_RETORNO);
    extratoData = null;
    retornoData = null;
    sbDelete("extrato").catch(() => {});
    sbDelete("retorno").catch(() => {});

    document.getElementById("extrato-filename").textContent = "Clique ou arraste o arquivo .xlsx aqui";
    document.getElementById("retorno-filename").textContent = "Clique ou arraste o arquivo .csv aqui";
    document.querySelector('label[for="input-extrato"]').classList.remove("loaded");
    document.querySelector('label[for="input-retorno"]').classList.remove("loaded");
    document.getElementById("input-extrato").value = "";
    document.getElementById("input-retorno").value = "";

    renderAll();
    showToast("Dados removidos.", "info");
  });
}

function applyLoadedExtrato() {
  if (!extratoData) return;
  localStorage.setItem(STORAGE_EXTRATO, JSON.stringify(extratoData));
  document.getElementById("extrato-filename").textContent = "✅ Extrato carregado";
  document.querySelector('label[for="input-extrato"]').classList.add("loaded");
}

function applyLoadedRetorno() {
  if (!retornoData) return;
  localStorage.setItem(STORAGE_RETORNO, JSON.stringify(retornoData));
  document.getElementById("retorno-filename").textContent = "✅ Retorno carregado";
  document.querySelector('label[for="input-retorno"]').classList.add("loaded");
}

function loadFromStorage() {
  // Carrega localStorage imediatamente (sem bloquear a UI)
  try { extratoData = JSON.parse(localStorage.getItem(STORAGE_EXTRATO)); } catch { extratoData = null; }
  try { retornoData = JSON.parse(localStorage.getItem(STORAGE_RETORNO)); } catch { retornoData = null; }
  applyLoadedExtrato();
  applyLoadedRetorno();

  // Sincroniza com Supabase em background — atualiza se tiver dado mais recente
  Promise.all([sbLoad("extrato"), sbLoad("retorno")])
    .then(([extVal, retVal]) => {
      showToast(`Supabase: extrato=${extVal ? "ok" : "vazio"} retorno=${retVal ? "ok" : "vazio"}`, "info", 6000);
      let atualizado = false;

      if (extVal && extVal.importadoEm !== extratoData?.importadoEm) {
        extratoData = extVal;
        applyLoadedExtrato();
        atualizado = true;
      }
      if (retVal && retVal.importadoEm !== retornoData?.importadoEm) {
        retornoData = retVal;
        applyLoadedRetorno();
        atualizado = true;
      }
      if (atualizado) {
        renderAll();
        showToast("Dados atualizados do servidor.", "info", 3000);
      }
    })
    .catch((err) => showToast("Erro Supabase: " + err.message, "error", 8000));
}

/* ---------------- Auth ---------------- */

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_SESSION));
  } catch {
    return null;
  }
}

function applyRolePermissions(session) {
  document.body.classList.toggle("role-viewer", session.role === "viewer");
  document.getElementById("user-info-name").textContent = session.label;

  if (session.role === "viewer" && document.querySelector('.page#page-importar').classList.contains("active")) {
    navigateTo("home");
  }
}

function setupLogin() {
  const screen = document.getElementById("login-screen");
  const form = document.getElementById("login-form");
  const error = document.getElementById("login-error");

  const session = getSession();
  if (session && USERS[session.user]) {
    screen.hidden = true;
    applyRolePermissions(session);
  } else {
    screen.hidden = false;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.getElementById("login-user").value.trim();
    const pass = document.getElementById("login-pass").value;
    const account = USERS[user];

    if (!account || account.password !== pass) {
      error.hidden = false;
      return;
    }

    error.hidden = true;
    const newSession = { user, role: account.role, label: account.label };
    localStorage.setItem(STORAGE_SESSION, JSON.stringify(newSession));
    applyRolePermissions(newSession);
    screen.hidden = true;
    form.reset();
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_SESSION);
    location.reload();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupLogin();
  setupNavigation();
  setupMobileNav();
  setupUploads();
  setupFilters();
  setupExports();
  setupClear();
  loadFromStorage();
  renderAll();
});
