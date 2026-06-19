// ARENERA · PANEL DE CONTROL — un solo archivo JSX
// Deploy: proyecto Vite React -> reemplazá src/App.jsx por este archivo -> push a GitHub -> import en Vercel.
// Persistencia: localStorage (funciona en Vercel; en la vista previa del chat puede no guardar entre recargas).

import React, { useState, useEffect, useMemo, useRef } from "react";
import { auth, db } from "./firebase";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

/* ────────────────────────────────────────────────────────────
   SUPUESTOS POR DEFECTO (editables desde la app)
   ──────────────────────────────────────────────────────────── */
const DEFAULTS = {
  precioBruta: 9000,        // $/tn boca de pozo
  precioGrillada: 9000,     // $/tn (subilo cuando confirmes el corralón)
  comisionSocios: 30,       // %
  regalia: 3,               // % de boca de mina
  tnPorBatea: 30,           // tn
  objetivoBrutaMes: 8,      // bateas/mes de bruta (objetivo)
  objetivoGrilladaMes: 4,   // bateas/mes de grillada (objetivo)
  gasoilPrecio: 1800,       // $/L
  palaConsumo: 9,           // L/h
  palaReserva: 11400,       // $/h (reparación + amortización pala)
  jornal: 35000,            // $/día (costo de la persona por jornada de carga)
  cargasSociales: 55,       // % sobre el jornal (0 si el jornal ya las incluye)
  bateasPorDia: 4,          // bateas que se cargan en una jornada típica (para repartir el costo del día)
  horasPalaBruta: 3,        // horas de pala de una jornada de bruta
  horasPalaGrillada: 5.5,   // horas de pala de una jornada de grillada
  jornalesBruta: 1,         // (legado, ya no se usa)
  jornalesGrillada: 2,      // (legado)
  variosBruta: 8000,
  variosGrillada: 15000,
  costoGrilla: 1500000,     // $ inversión grilla
  vidaGrillaAnios: 4,
  empleadoMes: 0,           // $ sueldo del empleado por mes (con cargas)
  empleadoDiasMes: 22,      // días totales que trabaja el empleado al mes
  empleadoDiasArena: 5,     // de esos, cuántos los usás en la arenera (solo esos se cargan a la arena)
  costosFijosMes: 0,        // $ otros costos fijos del mes (alquiler, seguros, etc.)
};

/* ────────────────────────────────────────────────────────────
   MOTOR DE CÁLCULO
   ──────────────────────────────────────────────────────────── */
// Costos VARIABLES de una jornada de carga del modo (pala + varios). Se reparten entre las bateas del día.
// El empleado NO va acá: es un costo fijo mensual (se paga cargues o no), se resta una vez al mes.
function costoFijoDia(cfg, modo) {
  const horas = modo === "grillada" ? cfg.horasPalaGrillada : cfg.horasPalaBruta;
  const varios = modo === "grillada" ? cfg.variosGrillada : cfg.variosBruta;
  const gasoil = horas * cfg.palaConsumo * cfg.gasoilPrecio;
  const reserva = horas * cfg.palaReserva;
  return { gasoil, reserva, varios, total: gasoil + reserva + varios };
}
// Parte del sueldo del empleado que le toca a la arenera: prorrateado por los días que lo usás acá.
// (Los otros días los paga el otro trabajo.)
function empleadoArena(cfg) {
  const dm = cfg.empleadoDiasMes || 0;
  const da = cfg.empleadoDiasArena || 0;
  const ratio = dm > 0 ? Math.min(da / dm, 1) : 1;
  return (cfg.empleadoMes || 0) * ratio;
}
// Total de costos fijos del mes que carga la arenera (empleado prorrateado + otros fijos).
function fijosMes(cfg) {
  return empleadoArena(cfg) + (cfg.costosFijosMes || 0);
}

function calcDia(cfg, modo, bateas, palaCliente) {
  const tn = bateas * cfg.tnPorBatea;
  const precio = modo === "grillada" ? cfg.precioGrillada : cfg.precioBruta;
  const ingresoBruto = tn * precio;
  const comision = ingresoBruto * (cfg.comisionSocios / 100);
  const regaliaMonto = ingresoBruto * (cfg.regalia / 100);
  const ingresoNeto = ingresoBruto - comision;

  // Dilución: estas bateas son una fracción (o varios) de una jornada de carga.
  const bpd = cfg.bateasPorDia > 0 ? cfg.bateasPorDia : 1;
  const dil = bateas / bpd;
  const f = costoFijoDia(cfg, modo);
  // Si la pala la pone el cliente, no hay gasoil ni desgaste de pala.
  const gasoil = palaCliente ? 0 : f.gasoil * dil;
  const reserva = palaCliente ? 0 : f.reserva * dil;
  const varios = f.varios * dil;
  const amortGrilla = modo === "grillada" ? amortGrillaTn(cfg) * tn : 0;

  // margen de CONTRIBUCIÓN (sin empleado: ese es fijo y se resta al mes)
  const costoTotal = gasoil + reserva + varios + regaliaMonto + amortGrilla;
  const margen = ingresoNeto - costoTotal;
  return {
    tn, precio, ingresoBruto, comision, regaliaMonto, ingresoNeto,
    gasoil, reserva, varios, amortGrilla, costoTotal,
    margen, margenTn: tn ? margen / tn : 0, margenBatea: bateas ? margen / bateas : 0,
  };
}

// La grilla se desgasta con el volumen GRILLADO: amortizamos sobre las tn de grillada del año.
function amortGrillaTn(cfg) {
  const tnVida = cfg.tnPorBatea * cfg.objetivoGrilladaMes * 12 * cfg.vidaGrillaAnios;
  return tnVida ? cfg.costoGrilla / tnVida : 0;
}

// neto $/tn de un modo a una escala de bateas dada (los costos fijos se reparten sobre esas tn)
function netoTn(cfg, modo, bateas) {
  const r = calcDia(cfg, modo, bateas || 1);
  return r.margenTn;
}

// precio de grillada al que EMPATA con bruta (break-even para que valga grillar)
function breakEvenGrillada(cfg) {
  const factor = 1 - cfg.comisionSocios / 100 - cfg.regalia / 100;
  if (factor <= 0) return Infinity;
  const tnB = cfg.tnPorBatea;
  if (tnB <= 0) return Infinity;
  const bpd = cfg.bateasPorDia > 0 ? cfg.bateasPorDia : 1;
  const opG = (costoFijoDia(cfg, "grillada").total / bpd) / tnB + amortGrillaTn(cfg);
  const netoB = netoTn(cfg, "bruta");
  return (netoB + opG) / factor;
}

// precio de bruta al que el margen se hace cero (zona de pérdida)
function breakEvenBruta(cfg) {
  const factor = 1 - cfg.comisionSocios / 100 - cfg.regalia / 100;
  if (factor <= 0) return Infinity;
  const tnB = cfg.tnPorBatea;
  if (tnB <= 0) return Infinity;
  const bpd = cfg.bateasPorDia > 0 ? cfg.bateasPorDia : 1;
  const opB = (costoFijoDia(cfg, "bruta").total / bpd) / tnB;
  return opB / factor;
}

/* ────────────────────────────────────────────────────────────
   ANALIZADOR DE PROPUESTAS
   Reutiliza el motor: pisa el precio con el ofrecido y, si es venta
   directa, anula la comisión de socios. Calcula con TUS costos.
   ──────────────────────────────────────────────────────────── */
function analizarPropuesta(cfg, modo, canal, precio, bateas, palaCliente) {
  const ov = {
    ...cfg,
    precioBruta: precio,
    precioGrillada: precio,
    comisionSocios: canal === "Directo" ? 0 : cfg.comisionSocios,
  };
  return calcDia(ov, modo, bateas, palaCliente);
}

// Precio mínimo por tn para no perder (margen = 0). Costo del día repartido por batea.
function pisoPropuesta(cfg, modo, canal, bateas, palaCliente) {
  const tnB = cfg.tnPorBatea;
  if (tnB <= 0) return Infinity;
  const com = canal === "Directo" ? 0 : cfg.comisionSocios;
  const factor = 1 - com / 100 - cfg.regalia / 100;
  if (factor <= 0) return Infinity;
  const bpd = cfg.bateasPorDia > 0 ? cfg.bateasPorDia : 1;
  const f = costoFijoDia(cfg, modo);
  const fijoDia = palaCliente ? f.varios : f.total; // sin pala si la trae el cliente
  const fijoPorBatea = fijoDia / bpd;
  const amortBatea = modo === "grillada" ? amortGrillaTn(cfg) * tnB : 0;
  return (fijoPorBatea + amortBatea) / (tnB * factor);
}

/* ────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────── */
const $ = (n) => (isFinite(n) ? "$" + Math.round(n).toLocaleString("es-AR") : "—");
const N = (n) => (isFinite(n) ? Math.round(n).toLocaleString("es-AR") : "—");
// id único: evita colisiones de Date.now() cuando se crean varios items en el mismo ms
const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
// fecha ISO en hora LOCAL (no UTC): evita que una carga de la noche caiga al día siguiente
const localISO = (d = new Date()) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};
const todayISO = () => localISO();
const tomorrowISO = () => { const d = new Date(); d.setDate(d.getDate() + 1); return localISO(d); };
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const fechaCorta = (iso) => { const d = new Date(iso + "T00:00:00"); return `${DIAS[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGO = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const mesLabel = (key) => { const [y, m] = key.split("-"); return `${MESES[parseInt(m) - 1]} ${y}`; };

function startOfWeek(d = new Date()) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // lunes = 0
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

const C = {
  // Base neumórfica en ARENA: la superficie es igual al fondo; el volumen lo dan las sombras.
  bg: "#e6dbc4",        // superficie = fondo (arena)
  panel: "#dccdb0",     // hundido sutil (encabezados de tabla)
  line: "#ccbd9c",      // divisores
  ink: "#2c2218",       // texto principal (alto contraste sobre arena)
  ink2: "#5e4f38",      // texto secundario (contraste accesible)
  accent: "#5a0f1c",    // bordó (marca + CTA) — se mantiene el color del logo
  gold: "#9c6f33",      // latón
  light: "#f6eed9",     // luz neumórfica (sombra clara)
  dark: "#c2b287",      // sombra oscura neumórfica
  cream: "#e6dbc4",     // compat (= bg)
  verde: "#1c6b3e", amarillo: "#8a6010", rojo: "#a82c20",
};

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

/* ────────────────────────────────────────────────────────────
   COMPONENTES CHICOS
   ──────────────────────────────────────────────────────────── */
function Dot({ color }) {
  return (
    <span style={{
      width: 13, height: 13, borderRadius: "50%", background: color,
      display: "inline-block", boxShadow: `0 0 0 4px ${color}22`, flexShrink: 0,
    }} />
  );
}

// Cada sección lleva su propio color de acento (mantiene la línea, solo cambia el tono del distintivo).
const SECTION_COLORS = {
  "Decisión": "#5a0f1c",     // bordó
  "Propuesta": "#1f5e7a",    // azul petróleo
  "Calculadora": "#8a5a14",  // latón
  "Cartera": "#2f6f63",      // verde azulado
  "Agenda": "#3f5488",       // azul acero
  "Operación": "#b0532b",    // terracota
  "Resumen": "#6a6526",      // oliva
  "Calendario": "#864f2e",   // tierra
  "Tablero": "#6d3a66",      // ciruela
  "Proyección": "#356b41",   // verde
  "Parámetros": "#4a4540",   // carbón cálido
  "Datos": "#3f5560",        // pizarra
};

// Tono del fondo de cada sección, intercalado claro/oscuro (misma paleta arena).
const TONO_CLARO = "#efe7d6";
const TONO_OSCURO = "#d9ccac";
const SECTION_TONE = {
  "Decisión": TONO_CLARO, "Calculadora": TONO_OSCURO, "Propuesta": TONO_CLARO, "Cartera": TONO_OSCURO,
  "Agenda": TONO_CLARO, "Operación": TONO_OSCURO, "Resumen": TONO_CLARO, "Calendario": TONO_OSCURO,
  "Tablero": TONO_CLARO, "Proyección": TONO_OSCURO, "Parámetros": TONO_CLARO, "Datos": TONO_CLARO,
};

function Section({ tag, title, right, children, id }) {
  const col = SECTION_COLORS[tag] || C.accent;
  const bg = SECTION_TONE[tag] || C.bg;
  return (
    <section className="card" id={id} style={{ background: bg }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <span style={{ width: 9, height: 9, background: col, display: "inline-block", borderRadius: 2 }} />
          <span className="label" style={{ color: col }}>{tag}</span>
        </div>
        {right}
      </div>
      <h2 style={{ margin: "0 0 18px", fontFamily: "Archivo, sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: "-0.01em", color: C.ink }}>{title}</h2>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div className="card kpi">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="label">{label}</span>
        <Dot color={color} />
      </div>
      <div className="num" style={{ fontSize: 30, marginTop: 10, color: C.ink }}>{value}</div>
      <div style={{ color: C.ink2, fontSize: 12.5, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Field({ label, value, onChange, suffix }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <div className="inputWrap">
        <input className="input" type="text" inputMode="decimal"
          value={value === null || value === undefined ? "" : value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
        {suffix && <span style={{ color: C.ink2, fontSize: 13, paddingRight: 12 }}>{suffix}</span>}
      </div>
    </label>
  );
}

/* ────────────────────────────────────────────────────────────
   APP
   ──────────────────────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────────
   ERROR BOUNDARY — si algo explota al renderizar, mostramos un
   cartel en vez de dejar la pantalla en blanco. Los datos siguen
   a salvo en el dispositivo (localStorage).
   ──────────────────────────────────────────────────────────── */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { try { console.error("El Retiro – error:", error, info); } catch {} }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Archivo, sans-serif" }}>
        <div className="card" style={{ maxWidth: 460, textAlign: "center", boxShadow: `9px 9px 20px ${C.dark}, -9px -9px 20px ${C.light}` }}>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: C.accent, fontWeight: 600 }}>Ups</div>
          <h2 style={{ fontFamily: "Archivo, sans-serif", fontWeight: 800, fontSize: 22, margin: "10px 0 8px" }}>Algo se trabó</h2>
          <p style={{ color: C.ink2, fontSize: 14, lineHeight: 1.5, margin: "0 0 18px" }}>
            Tus datos están a salvo en tu cuenta, no se perdieron. Recargá la app para seguir.
          </p>
          <button className="btn" onClick={() => window.location.reload()}>Recargar</button>
        </div>
      </div>
    );
  }
}

/* ────────────────────────────────────────────────────────────
   AUTENTICACIÓN — login por email/clave (Firebase Auth).
   No hay registro público: los usuarios los creás vos en la consola.
   ──────────────────────────────────────────────────────────── */
function Splash() {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Mono',monospace", color: C.ink2, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 12 }}>
      Cargando…
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function entrar(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pass);
    } catch (_) {
      setErr("Email o contraseña incorrectos.");
      setBusy(false);
    }
  }
  const inputStyle = { boxSizing: "border-box", width: "100%", border: 0, borderRadius: 13, background: C.bg, padding: "13px 15px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, fontWeight: 600, color: C.ink, outline: "none", boxShadow: `inset 3px 3px 6px ${C.dark}, inset -3px -3px 6px ${C.light}` };
  const labStyle = { display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 7, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'IBM Plex Mono',monospace" };
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Archivo, sans-serif" }}>
      <form onSubmit={entrar} style={{ width: "100%", maxWidth: 380, background: C.bg, borderRadius: 22, padding: "32px 28px", boxShadow: `9px 9px 20px ${C.dark}, -9px -9px 20px ${C.light}` }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <img src="/logo.png" alt="El Retiro" style={{ width: 190, height: "auto", display: "inline-block" }} />
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: C.accent, fontWeight: 600, marginTop: 8 }}>Panel de control</div>
        </div>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={labStyle}>Email</span>
          <input style={inputStyle} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label style={{ display: "block", marginBottom: 20 }}>
          <span style={labStyle}>Contraseña</span>
          <input style={inputStyle} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required />
        </label>
        {err && <div style={{ color: C.rojo, fontSize: 13, fontWeight: 600, marginBottom: 16, textAlign: "center" }}>{err}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", border: 0, borderRadius: 13, padding: "14px", cursor: busy ? "default" : "pointer", background: C.accent, color: "#fff", fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", fontSize: 13, boxShadow: `5px 5px 12px ${C.dark}, -5px -5px 12px ${C.light}`, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <div style={{ textAlign: "center", marginTop: 18, fontSize: 12, color: C.ink2, lineHeight: 1.5 }}>
          Acceso solo para usuarios autorizados.
        </div>
      </form>
    </div>
  );
}

function AuthGate() {
  const [user, setUser] = useState(undefined); // undefined = cargando · null = sin sesión
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u || null)), []);
  if (user === undefined) return <Splash />;
  if (!user) return <Login />;
  return <AppInner user={user} />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthGate />
    </ErrorBoundary>
  );
}

function AppInner({ user }) {
  const [cfg, setCfg] = useState(() => ({ ...DEFAULTS }));
  const [registros, setRegistros] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [programadas, setProgramadas] = useState([]);
  const [propuestas, setPropuestas] = useState([]);
  const [qBruta, setQBruta] = useState(DEFAULTS.objetivoBrutaMes);
  const [qGrillada, setQGrillada] = useState(DEFAULTS.objetivoGrilladaMes);
  const [showCfg, setShowCfg] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  const [cal, setCal] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [importErr, setImportErr] = useState("");
  const [pendingImport, setPendingImport] = useState(null);
  const [cfgDraft, setCfgDraft] = useState(() => ({ ...DEFAULTS }));
  const [cfgSaved, setCfgSaved] = useState(false);

  // form de carga
  const [fFecha, setFFecha] = useState(todayISO());
  const [fModo, setFModo] = useState("bruta");
  const [fBateas, setFBateas] = useState(1);
  const [fClienteId, setFClienteId] = useState("");
  const [fCanal, setFCanal] = useState("Intermediario");
  const [fPalaCliente, setFPalaCliente] = useState(false);
  const [editId, setEditId] = useState(null);        // id del registro en edición (null = alta nueva)

  // deshacer borrados (toast)
  const [undo, setUndo] = useState(null);            // { tipo, item, index, msg }
  const undoTimer = useRef(null);

  // form de programar carga
  const [pFecha, setPFecha] = useState(tomorrowISO());
  const [pClienteId, setPClienteId] = useState("");
  const [pBateas, setPBateas] = useState(1);
  const [pModo, setPModo] = useState("bruta");
  const [pNota, setPNota] = useState("");
  const [pPalaCliente, setPPalaCliente] = useState(false);

  // form de cliente
  const [cNombre, setCNombre] = useState("");
  const [cLocalidad, setCLocalidad] = useState("");
  const [cTel, setCTel] = useState("");
  const [cCanal, setCCanal] = useState("Intermediario");

  // form de propuesta a analizar
  const [prQuien, setPrQuien] = useState("");
  const [prPrecio, setPrPrecio] = useState("");
  const [prModo, setPrModo] = useState("bruta");
  const [prCanal, setPrCanal] = useState("Directo");
  const [prBateas, setPrBateas] = useState(1);
  const [prTn, setPrTn] = useState(DEFAULTS.tnPorBatea);
  const [prPalaCliente, setPrPalaCliente] = useState(false);
  const [propExp, setPropExp] = useState({});       // {id: true} propuestas desplegadas
  const [verDesgloseCalc, setVerDesgloseCalc] = useState(false); // desglose de costos en la calculadora

  // ── Sincronización con Firestore (un documento por usuario) ──
  const hydrated = useRef(false);   // true cuando ya recibimos los datos del servidor (evita pisar con vacío)
  const lastSync = useRef("");      // último estado conocido del server (evita bucle de escrituras)
  const saveTimer = useRef(null);

  // 1) Escuchar el panel del usuario en vivo
  useEffect(() => {
    hydrated.current = false; lastSync.current = "";
    const ref = doc(db, "paneles", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const d = snap.data() || {};
        const cfgL = { ...DEFAULTS, ...(d.cfg || {}) };
        const regL = Array.isArray(d.registros) ? d.registros : [];
        const cliL = Array.isArray(d.clientes) ? d.clientes : [];
        const progL = Array.isArray(d.programadas) ? d.programadas : [];
        const propL = Array.isArray(d.propuestas) ? d.propuestas : [];
        // Plan de la calculadora: si está guardado lo usamos; si no, arranca en el objetivo mensual.
        const planB = d.plan && typeof d.plan.bruta === "number" ? d.plan.bruta : cfgL.objetivoBrutaMes;
        const planG = d.plan && typeof d.plan.grillada === "number" ? d.plan.grillada : cfgL.objetivoGrilladaMes;
        setCfg(cfgL);
        if (!hydrated.current) {
          setCfgDraft(cfgL);        // no pisar una edición en curso de supuestos
          setQBruta(planB);         // ni el plan que esté tocando en la calculadora
          setQGrillada(planG);
        }
        setRegistros(regL);
        setClientes(cliL);
        setProgramadas(progL);
        setPropuestas(propL);
        lastSync.current = JSON.stringify({ cfg: cfgL, registros: regL, clientes: cliL, programadas: progL, propuestas: propL, plan: { bruta: planB, grillada: planG } });
        hydrated.current = true;
      },
      (e) => { try { console.error("Firestore:", e); } catch {} hydrated.current = true; }
    );
    return unsub;
  }, [user.uid]);

  // 2) Guardar cambios locales (con rebote), solo después de hidratar y solo si cambió algo
  useEffect(() => {
    if (!hydrated.current) return;
    const estado = { cfg, registros, clientes, programadas, propuestas, plan: { bruta: qBruta, grillada: qGrillada } };
    const json = JSON.stringify(estado);
    if (json === lastSync.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Firestore NO acepta valores undefined: el clon por JSON los elimina (deja la data limpia).
      const payload = JSON.parse(JSON.stringify(estado));
      setDoc(doc(db, "paneles", user.uid), payload, { merge: true })
        .then(() => { lastSync.current = json; })
        .catch((e) => { try { console.error("No se pudo guardar:", e); } catch {} });
    }, 600);
  }, [cfg, registros, clientes, programadas, propuestas, qBruta, qGrillada, user.uid]);

  // El objetivo del mes ES el plan de la calculadora: mantenemos cfg (y el borrador) en sync (KPI, amortización, persistencia).
  useEffect(() => {
    const b = parseFloat(qBruta) || 0, g = parseFloat(qGrillada) || 0;
    setCfg((c) => (c.objetivoBrutaMes === b && c.objetivoGrilladaMes === g ? c : { ...c, objetivoBrutaMes: b, objetivoGrilladaMes: g }));
    setCfgDraft((d) => (d.objetivoBrutaMes === b && d.objetivoGrilladaMes === g ? d : { ...d, objetivoBrutaMes: b, objetivoGrilladaMes: g }));
  }, [qBruta, qGrillada]);

  const setD = (k) => (v) => { setCfgDraft((d) => ({ ...d, [k]: v })); setCfgSaved(false); };
  const normCfg = (obj) => { const o = {}; for (const k in obj) { const v = obj[k]; o[k] = typeof v === "number" ? v : (parseFloat(v) || 0); } return o; };
  const cfgDirty = useMemo(() => JSON.stringify(normCfg(cfgDraft)) !== JSON.stringify(cfg), [cfgDraft, cfg]);
  function guardarCfg() {
    const norm = normCfg(cfgDraft);
    setCfg(norm);
    setCfgDraft(norm);
    setCfgSaved(true);
    setTimeout(() => setCfgSaved(false), 2500);
  }

  // Economía de un registro: usa el snapshot inmutable guardado al cargar (r.econ).
  // Para registros viejos sin snapshot, cae a recalcular con cfg actual (compatibilidad).
  const econDe = (r) => (r && r.econ ? r.econ : calcDia(cfg, r.modo, r.bateas, r.palaCliente));

  // Planificador del mes: cálculo por modo a las cantidades elegidas
  const diaB = useMemo(() => calcDia(cfg, "bruta", qBruta), [cfg, qBruta]);
  const diaG = useMemo(() => calcDia(cfg, "grillada", qGrillada), [cfg, qGrillada]);
  const beG = useMemo(() => breakEvenGrillada(cfg, qGrillada, qBruta), [cfg, qGrillada, qBruta]);
  const beB = useMemo(() => breakEvenBruta(cfg, qBruta), [cfg, qBruta]);
  const netoB = diaB.margenTn;
  const netoG = diaG.margenTn;
  const totalMargenMes = diaB.margen + diaG.margen;
  const totalTnMes = diaB.tn + diaG.tn;

  // decisión bruta vs grillada — reacciona a las cantidades y a los precios/costos de supuestos
  const dif = netoG - netoB;
  let dec;
  if (dif > 100) dec = { color: C.verde, txt: "CONVIENE GRILLAR", msg: `La grillada deja ${$(dif)}/tn más que la bruta con estos precios y costos.` };
  else if (dif >= -100) dec = { color: C.amarillo, txt: "EMPATE → VENDÉ BRUTA", msg: "Casi lo mismo: menos laburo y desgaste yendo en bruta." };
  else dec = { color: C.rojo, txt: "VENDÉ BRUTA", msg: `Grillar te resta ${$(-dif)}/tn. No conviene a estos precios.` };

  // ── Análisis en vivo de la propuesta ──
  const prPrecioNum = parseFloat(prPrecio) || 0;
  const prBateasNum = parseFloat(prBateas) || 0;
  const prEcon = useMemo(
    () => analizarPropuesta(cfg, prModo, prCanal, prPrecioNum, prBateasNum, prPalaCliente),
    [cfg, prModo, prCanal, prPrecioNum, prBateasNum, prPalaCliente]
  );
  const prPiso = useMemo(
    () => pisoPropuesta(cfg, prModo, prCanal, prBateasNum, prPalaCliente),
    [cfg, prModo, prCanal, prBateasNum, prPalaCliente]
  );
  let prDec;
  if (prPrecioNum <= 0 || prBateasNum <= 0) {
    prDec = { color: C.ink2, txt: "CARGÁ LA PROPUESTA", msg: "Poné el precio ofrecido y la cantidad para analizarla." };
  } else if (prPrecioNum < prPiso) {
    prDec = { color: C.rojo, txt: "NO CONVIENE", msg: `Perdés ${$(-prEcon.margen)}. No bajes de ~${$(prPiso)}/tn para no perder.` };
  } else if (prPrecioNum < prPiso * 1.12) {
    prDec = { color: C.amarillo, txt: "AL LÍMITE", msg: `Apenas pasa el piso (~${$(prPiso)}/tn). Deja ${$(prEcon.margenTn)}/tn.` };
  } else {
    prDec = { color: C.verde, txt: "BUENA PROPUESTA", msg: `Deja ${$(prEcon.margen)} (${$(prEcon.margenTn)}/tn). Tu piso es ~${$(prPiso)}/tn.` };
  }
  const prVeredicto = prDec.color === C.verde ? "Conviene" : prDec.color === C.amarillo ? "Al límite" : prDec.color === C.rojo ? "No conviene" : "—";
  // cuánto cubre del objetivo mensual (lo fijado en la calculadora)
  const prObjetivo = prModo === "bruta" ? qBruta : qGrillada;
  const prCobertura = prObjetivo > 0 ? (prBateasNum / prObjetivo) * 100 : 0;

  // Avance del objetivo según las propuestas guardadas (bruta / grillada por separado)
  const propAgg = useMemo(() => {
    let bB = 0, bG = 0, mB = 0, mG = 0;
    for (const p of propuestas) {
      const b = parseFloat(p.bateas) || 0;
      const m = p.margen || 0;
      if (p.modo === "grillada") { bG += b; mG += m; } else { bB += b; mB += m; }
    }
    return { bB, bG, mB, mG };
  }, [propuestas]);

  // métricas del mes / semana
  const stats = useMemo(() => {
    const now = new Date(); const m = now.getMonth(), y = now.getFullYear();
    const sow = startOfWeek(now);
    let tnMes = 0, ingMes = 0, comMes = 0, costoMes = 0, margenMes = 0, tnDir = 0, batSem = 0, batMes = 0;
    for (const r of registros) {
      const d = new Date(r.fecha + "T00:00:00");
      const calc = econDe(r);
      if (d.getMonth() === m && d.getFullYear() === y) {
        tnMes += calc.tn; ingMes += calc.ingresoBruto; comMes += calc.comision;
        costoMes += calc.costoTotal; margenMes += calc.margen;
        batMes += (parseFloat(r.bateas) || 0);
        if (r.canal === "Directo") tnDir += calc.tn;
      }
      if (d >= sow) batSem += r.bateas;
    }
    return { tnMes, ingMes, comMes, costoMes, margenMes, tnDir, batSem, batMes,
      pctDir: tnMes ? (tnDir / tnMes) * 100 : 0, costoTn: tnMes ? costoMes / tnMes : 0 };
  }, [registros, cfg]);

  // objetivo mensual total de bateas (bruta + grillada)
  const objMes = (parseFloat(qBruta) || 0) + (parseFloat(qGrillada) || 0); // el objetivo del mes = el plan de la calculadora

  // alertas
  const programadasSort = useMemo(
    () => [...programadas].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)),
    [programadas]
  );
  const pendientesConfirmar = useMemo(
    () => programadas.filter((p) => p.fecha <= todayISO()).length,
    [programadas]
  );

  const alertas = [];
  if (pendientesConfirmar > 0)
    alertas.push({ color: C.accent, t: `${pendientesConfirmar} carga(s) para confirmar`, d: "Llegó el día de cargas programadas. Confirmá si se hicieron o descartalas en 'Cargas programadas'." });
  if (cfg.precioBruta <= beB * 1.15)
    alertas.push({ color: C.rojo, t: "Precio cerca de pérdida", d: `La bruta no rinde por debajo de ~${$(beB)}/tn. Estás en zona de riesgo.` });
  if (cfg.precioGrillada === cfg.precioBruta)
    alertas.push({ color: C.amarillo, t: "Falta confirmar precio de grillada", d: `Llamá al corralón. Grillar conviene solo desde ~${$(beG)}/tn.` });
  if (stats.tnMes > 0 && stats.pctDir < 20)
    alertas.push({ color: C.amarillo, t: "Dependés del intermediario", d: `Solo ${N(stats.pctDir)}% de las ventas del mes son directas. Cada tn directa recupera ${$(cfg.precioBruta * cfg.comisionSocios / 100)}/tn.` });
  if (objMes > 0 && stats.batMes >= objMes)
    alertas.push({ color: C.verde, t: "Objetivo del mes cumplido", d: `${stats.batMes} de ${objMes} bateas este mes. Cada batea extra deja casi puro margen.` });

  const semDir = stats.pctDir > 50 ? C.verde : stats.pctDir >= 20 ? C.amarillo : C.rojo;
  const semBat = objMes > 0 && stats.batMes >= objMes ? C.verde : stats.batMes >= 1 ? C.amarillo : C.rojo;
  const semMar = stats.margenMes > 0 ? C.verde : stats.margenMes < 0 ? C.rojo : C.amarillo;

  // historial por cliente (ordenado por margen, mejores arriba)
  const clientesStats = useMemo(() => {
    return clientes.map((cl) => {
      let tn = 0, margen = 0, cargas = 0, ultima = null;
      for (const r of registros) {
        if (r.clienteId !== cl.id) continue;
        const c = econDe(r);
        tn += c.tn; margen += c.margen; cargas += 1;
        if (!ultima || r.fecha > ultima) ultima = r.fecha;
      }
      return { ...cl, tn, margen, cargas, ultima };
    }).sort((a, b) => b.margen - a.margen);
  }, [clientes, registros, cfg]);

  // resumen por mes (más reciente arriba)
  const resumenMeses = useMemo(() => {
    const map = {};
    for (const r of registros) {
      const key = r.fecha.slice(0, 7);
      const c = econDe(r);
      if (!map[key]) map[key] = { key, tn: 0, bruto: 0, comision: 0, costo: 0, margen: 0, bateas: 0, cargas: 0 };
      const o = map[key];
      o.tn += c.tn; o.bruto += c.ingresoBruto; o.comision += c.comision;
      o.costo += c.costoTotal; o.margen += c.margen; o.bateas += r.bateas; o.cargas += 1;
    }
    return Object.values(map).sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [registros, cfg]);

  // datos del calendario del mes visible
  const calData = useMemo(() => {
    const days = {};
    for (const r of registros) {
      const d = new Date(r.fecha + "T00:00:00");
      if (d.getFullYear() === cal.y && d.getMonth() === cal.m) {
        const day = d.getDate();
        const c = econDe(r);
        if (!days[day]) days[day] = { tn: 0, bateas: 0, cargas: 0 };
        days[day].tn += c.tn; days[day].bateas += r.bateas; days[day].cargas += 1;
      }
    }
    const offset = (new Date(cal.y, cal.m, 1).getDay() + 6) % 7;
    const ndays = new Date(cal.y, cal.m + 1, 0).getDate();
    const vals = Object.values(days).map((d) => d.tn);
    const maxTn = vals.length ? Math.max(...vals) : 1;
    const tnMes = vals.reduce((a, b) => a + b, 0);
    return { days, offset, ndays, maxTn, tnMes };
  }, [registros, cfg, cal]);

  // picos de extracción (últimos 12 meses, tn por mes)
  const picos = useMemo(() => {
    const arr = [...resumenMeses].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(-12);
    const max = arr.length ? Math.max(...arr.map((m) => m.tn)) : 1;
    return { arr, max };
  }, [resumenMeses]);

  function calNav(delta) {
    setCal((c) => { let m = c.m + delta, y = c.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } return { y, m }; });
  }

  // proyección — sobre el plan mensual (bruta + grillada)
  const proyMes = totalMargenMes;
  const proySem = totalMargenMes / 4.33;
  const proyAnio = totalMargenMes * 12;

  function resetFormCarga() {
    setEditId(null); setFFecha(todayISO()); setFModo("bruta");
    setFBateas(1); setFClienteId(""); setFCanal("Intermediario"); setFPalaCliente(false);
  }
  function registrar() {
    const b = parseFloat(fBateas) || 0;
    if (b <= 0 || !fClienteId) return;
    const cl = clientes.find((c) => String(c.id) === String(fClienteId));
    const datos = {
      fecha: fFecha, modo: fModo, bateas: b,
      clienteId: fClienteId, cliente: cl ? cl.nombre : "—", canal: fCanal,
      palaCliente: fPalaCliente,
      econ: calcDia(cfg, fModo, b, fPalaCliente),
    };
    if (editId) {
      // edición: actualiza en su lugar y vuelve a modo alta
      setRegistros((rs) => rs.map((r) => (r.id === editId ? { ...r, ...datos } : r)));
      resetFormCarga();
    } else {
      setRegistros((rs) => [{ id: newId(), ...datos }, ...rs]);
      setFBateas(1);
    }
  }
  function editar(r) {
    setEditId(r.id);
    setFFecha(r.fecha); setFModo(r.modo); setFBateas(r.bateas);
    setFClienteId(r.clienteId || ""); setFCanal(r.canal || "Intermediario"); setFPalaCliente(!!r.palaCliente);
    try { document.getElementById("form-registro")?.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
  }
  // borrado con deshacer: saca el item y arma el toast; si no se deshace en 6s, queda firme
  function armarUndo(tipo, item, index, msg) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ tipo, item, index, msg });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }
  function borrar(id) {
    const idx = registros.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const item = registros[idx];
    setRegistros((rs) => rs.filter((r) => r.id !== id));
    if (editId === id) resetFormCarga();
    armarUndo("registro", item, idx, "Carga eliminada");
  }
  function deshacer() {
    if (!undo) return;
    const { tipo, item, index } = undo;
    if (tipo === "registro") setRegistros((rs) => { const a = [...rs]; a.splice(Math.min(index, a.length), 0, item); return a; });
    if (tipo === "cliente") setClientes((cs) => { const a = [...cs]; a.splice(Math.min(index, a.length), 0, item); return a; });
    if (tipo === "propuesta") setPropuestas((ps) => { const a = [...ps]; a.splice(Math.min(index, a.length), 0, item); return a; });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
  }

  // ── Propuestas: cantidad vinculada tn↔bateas, guardar y borrar ──
  function setBateasProp(v) {
    setPrBateas(v);
    const b = parseFloat(v) || 0;
    setPrTn(b ? +(b * cfg.tnPorBatea).toFixed(2) : 0);
  }
  function setTnProp(v) {
    setPrTn(v);
    const t = parseFloat(v) || 0;
    setPrBateas(cfg.tnPorBatea ? +(t / cfg.tnPorBatea).toFixed(2) : 0);
  }
  function guardarPropuesta() {
    const precio = parseFloat(prPrecio) || 0;
    const b = parseFloat(prBateas) || 0;
    if (precio <= 0 || b <= 0) return;
    const econ = analizarPropuesta(cfg, prModo, prCanal, precio, b, prPalaCliente);
    const piso = pisoPropuesta(cfg, prModo, prCanal, b, prPalaCliente);
    const veredicto = precio < piso ? "No conviene" : precio < piso * 1.12 ? "Al límite" : "Conviene";
    setPropuestas((ps) => [
      { id: newId(), fecha: todayISO(), quien: prQuien.trim() || "—",
        modo: prModo, canal: prCanal, precio, bateas: b, tn: econ.tn, palaCliente: prPalaCliente,
        margen: econ.margen, margenTn: econ.margenTn, piso, veredicto, econ },
      ...ps,
    ]);
    setPrQuien(""); setPrPrecio("");
  }
  function borrarPropuesta(id) {
    const idx = propuestas.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const item = propuestas[idx];
    setPropuestas((ps) => ps.filter((p) => p.id !== id));
    armarUndo("propuesta", item, idx, "Propuesta eliminada");
  }
  // Exporta una propuesta a PDF abriendo el diálogo de impresión (Guardar como PDF). Sin librerías.
  function exportarPropuestaPDF(p) {
    const e = p.econ || analizarPropuesta(cfg, p.modo, p.canal, p.precio, p.bateas, p.palaCliente);
    const piso = p.piso != null ? p.piso : pisoPropuesta(cfg, p.modo, p.canal, p.bateas, p.palaCliente);
    const fmt = (n) => (isFinite(n) ? "$" + Math.round(n).toLocaleString("es-AR") : "—");
    const vCol = p.veredicto === "Conviene" ? "#1c6b3e" : p.veredicto === "Al límite" ? "#8a6010" : "#a82c20";
    const row = (l, v, neg) => `<tr><td>${l}</td><td style="text-align:right;font-family:monospace;${neg ? "color:#a82c20" : ""}">${v}</td></tr>`;
    const filas = [
      row("Ingreso bruto", fmt(e.ingresoBruto)),
      p.canal !== "Directo" ? row(`− Comisión intermediario (${cfg.comisionSocios}%)`, "−" + fmt(e.comision), true) : row("Comisión intermediario", "venta directa"),
      row(`− Regalía (${cfg.regalia}%)`, "−" + fmt(e.regaliaMonto), true),
      p.palaCliente ? row("Pala", "la pone el cliente") : row("− Gasoil + reserva pala", "−" + fmt(e.gasoil + e.reserva), true),
      row("− Varios", "−" + fmt(e.varios), true),
      p.modo === "grillada" ? row("− Amortización grilla", "−" + fmt(e.amortGrilla), true) : "",
    ].join("");
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Propuesta El Retiro</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#211b17;max-width:640px;margin:24px auto;padding:0 16px}
h1{color:#5a0f1c;margin:0 0 2px;font-size:24px;letter-spacing:-.02em}
.sub{color:#857a6e;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:18px}
table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:7px 0;border-bottom:1px solid #e7e0d4;font-size:14px}
.tot td{border-top:2px solid #211b17;border-bottom:0;font-weight:bold;font-size:17px;padding-top:12px}
.meta{background:#f5efe6;border-radius:10px;padding:12px 16px;font-size:13px;margin-bottom:8px;line-height:1.6}
.vd{display:inline-block;padding:7px 16px;border-radius:20px;font-weight:bold;font-size:14px;margin-top:12px}
.ft{color:#857a6e;font-size:11px;margin-top:26px}</style></head><body>
<h1>EL RETIRO</h1><div class="sub">Análisis de propuesta · Arenera · Sol de Julio</div>
<div class="meta"><b>${p.quien || "—"}</b> &middot; ${p.fecha}<br>${p.bateas} bateas &middot; ${Math.round(p.tn)} tn &middot; arena ${p.modo} &middot; venta ${p.canal === "Directo" ? "Directo" : "Intermediario"} &middot; precio ${fmt(p.precio)}/tn</div>
<table><tbody>${filas}<tr class="tot"><td>Margen (te queda a vos)</td><td style="text-align:right;font-family:monospace;color:${e.margen >= 0 ? "#1c6b3e" : "#a82c20"}">${fmt(e.margen)}</td></tr></tbody></table>
<table><tbody>${row("Margen por tonelada", fmt(e.margenTn) + "/tn")}${row("Piso para no perder", fmt(piso) + "/tn")}</tbody></table>
<div class="vd" style="background:${vCol}22;color:${vCol}">${p.veredicto || "—"}</div>
<div class="ft">Generado con El Retiro · ${new Date().toLocaleDateString("es-AR")}</div>
<script>window.onload=function(){window.print()}<\/script></body></html>`;
    const w = window.open("", "_blank");
    if (!w) { setImportErr("El navegador bloqueó la ventana. Permití las ventanas emergentes para exportar el PDF."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  function programar() {
    const b = parseFloat(pBateas) || 0;
    if (b <= 0 || !pClienteId || !pFecha) return;
    const cl = clientes.find((c) => String(c.id) === String(pClienteId));
    setProgramadas((ps) => [
      ...ps,
      { id: newId(), fecha: pFecha, clienteId: pClienteId, cliente: cl ? cl.nombre : "—",
        canal: cl ? cl.canal : "Intermediario", bateas: b, modo: pModo, nota: pNota.trim(), palaCliente: pPalaCliente },
    ]);
    setPBateas(1); setPNota(""); setPClienteId(""); setPPalaCliente(false);
  }
  function descartarProgramada(id) { setProgramadas((ps) => ps.filter((p) => p.id !== id)); }
  function registrarProgramada(p) {
    const b = parseFloat(p.bateas) || 0;
    setRegistros((rs) => [
      { id: newId(), fecha: p.fecha, modo: p.modo, bateas: b,
        clienteId: p.clienteId, cliente: p.cliente, canal: p.canal, palaCliente: !!p.palaCliente,
        econ: calcDia(cfg, p.modo, b, p.palaCliente) },
      ...rs,
    ]);
    setProgramadas((ps) => ps.filter((x) => x.id !== p.id));
  }
  function mensajeProg(p) {
    const tn = (parseFloat(p.bateas) || 0) * cfg.tnPorBatea;
    let m = `*Carga El Retiro* — ${fechaCorta(p.fecha)}\n`;
    m += `Cliente: ${p.cliente}\n`;
    m += `${p.bateas} batea(s) · arena ${p.modo}\n`;
    m += `Total: ${N(tn)} tn`;
    if (p.nota) m += `\nNota: ${p.nota}`;
    return m;
  }
  function enviarOperario(p) {
    const txt = mensajeProg(p);
    try {
      if (navigator.share) { navigator.share({ text: txt }).catch(() => {}); return; }
    } catch {}
    window.open("https://wa.me/?text=" + encodeURIComponent(txt), "_blank");
  }

  function agregarCliente() {
    if (!cNombre.trim()) return;
    setClientes((cs) => [
      ...cs,
      { id: newId(), nombre: cNombre.trim(), localidad: cLocalidad.trim(), tel: cTel.trim(), canal: cCanal },
    ]);
    setCNombre(""); setCLocalidad(""); setCTel(""); setCCanal("Intermediario");
  }
  function borrarCliente(id) {
    const idx = clientes.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const item = clientes[idx];
    setClientes((cs) => cs.filter((c) => c.id !== id));
    armarUndo("cliente", item, idx, "Cliente eliminado");
  }

  function elegirCliente(id) {
    setFClienteId(id);
    const cl = clientes.find((c) => String(c.id) === String(id));
    if (cl) setFCanal(cl.canal);
  }

  function exportar() {
    try {
      const data = { app: "El Retiro", version: 1, fecha: new Date().toISOString(), cfg, registros, clientes, programadas };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `el-retiro-respaldo-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setImportErr("");
    } catch { setImportErr("No se pudo exportar en este navegador."); }
  }

  // ── Exportar resúmenes (CSV abrible en Excel) ──
  // Agrupa las cargas por período y separa bruta/grillada, con tn, ingreso, comisión, costos y margen.
  function filasResumen(keyFn, labelFn) {
    const map = {};
    for (const r of registros) {
      const key = keyFn(r.fecha);
      if (!map[key]) map[key] = { key, batB: 0, batG: 0, tnB: 0, tnG: 0, ing: 0, com: 0, costo: 0, margen: 0, tnDir: 0 };
      const o = map[key];
      const c = econDe(r);
      const b = parseFloat(r.bateas) || 0;
      if (r.modo === "grillada") { o.batG += b; o.tnG += c.tn; } else { o.batB += b; o.tnB += c.tn; }
      o.ing += c.ingresoBruto; o.com += c.comision; o.costo += c.costoTotal; o.margen += c.margen;
      if (r.canal === "Directo") o.tnDir += c.tn;
    }
    return Object.values(map).sort((a, b) => (a.key < b.key ? 1 : -1)).map((o) => ({ ...o, label: labelFn(o.key) }));
  }
  function descargarCSV(nombre, filas) {
    const sep = ";"; // separador apto para Excel en español
    const head = ["Período", "Bateas bruta", "Bateas grillada", "Bateas total", "Tn bruta", "Tn grillada", "Tn total", "Ingreso bruto", "Comisión intermediario", "Costos", "Margen", "Tn directas", "% directas"];
    const lineas = [head.join(sep)];
    const tot = { batB: 0, batG: 0, tnB: 0, tnG: 0, ing: 0, com: 0, costo: 0, margen: 0, tnDir: 0 };
    const fila = (label, f) => {
      const tnTot = f.tnB + f.tnG; const pct = tnTot ? (f.tnDir / tnTot) * 100 : 0;
      return [label, Math.round(f.batB), Math.round(f.batG), Math.round(f.batB + f.batG), Math.round(f.tnB), Math.round(f.tnG), Math.round(tnTot), Math.round(f.ing), Math.round(f.com), Math.round(f.costo), Math.round(f.margen), Math.round(f.tnDir), Math.round(pct)].join(sep);
    };
    for (const f of filas) {
      lineas.push(fila(f.label, f));
      tot.batB += f.batB; tot.batG += f.batG; tot.tnB += f.tnB; tot.tnG += f.tnG;
      tot.ing += f.ing; tot.com += f.com; tot.costo += f.costo; tot.margen += f.margen; tot.tnDir += f.tnDir;
    }
    lineas.push(fila("TOTAL", tot));
    const csv = "﻿" + lineas.join("\r\n"); // BOM para que Excel respete los acentos
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  function exportarResumenMensual() {
    if (!registros.length) { setImportErr("Todavía no hay cargas para exportar."); return; }
    setImportErr("");
    descargarCSV(`el-retiro-resumen-mensual-${todayISO()}.csv`, filasResumen((f) => f.slice(0, 7), (k) => mesLabel(k)));
  }
  function exportarResumenSemanal() {
    if (!registros.length) { setImportErr("Todavía no hay cargas para exportar."); return; }
    setImportErr("");
    descargarCSV(
      `el-retiro-resumen-semanal-${todayISO()}.csv`,
      filasResumen(
        (f) => localISO(startOfWeek(new Date(f + "T00:00:00"))),
        (k) => "Semana del " + k.split("-").reverse().join("/")
      )
    );
  }
  // Resumen mensual/semanal a PDF (vía impresión → Guardar como PDF). Sin librerías.
  function exportarResumenPDF(tipo) {
    if (!registros.length) { setImportErr("Todavía no hay cargas para exportar."); return; }
    setImportErr("");
    const filas = tipo === "semanal"
      ? filasResumen((f) => localISO(startOfWeek(new Date(f + "T00:00:00"))), (k) => "Semana " + k.split("-").reverse().join("/"))
      : filasResumen((f) => f.slice(0, 7), (k) => mesLabel(k));
    const fmt = (n) => (isFinite(n) ? "$" + Math.round(n).toLocaleString("es-AR") : "—");
    const nf = (n) => Math.round(n).toLocaleString("es-AR");
    const tot = { bat: 0, tn: 0, ing: 0, com: 0, margen: 0 };
    const trs = filas.map((f) => {
      const tnTot = f.tnB + f.tnG, bat = f.batB + f.batG;
      tot.bat += bat; tot.tn += tnTot; tot.ing += f.ing; tot.com += f.com; tot.margen += f.margen;
      return `<tr><td>${f.label}</td><td class="r">${nf(bat)}</td><td class="r">${nf(tnTot)}</td><td class="r">${fmt(f.ing)}</td><td class="r" style="color:#a82c20">−${nf(f.com)}</td><td class="r" style="color:${f.margen >= 0 ? "#1c6b3e" : "#a82c20"}">${fmt(f.margen)}</td></tr>`;
    }).join("");
    const totRow = `<tr class="tot"><td>TOTAL</td><td class="r">${nf(tot.bat)}</td><td class="r">${nf(tot.tn)}</td><td class="r">${fmt(tot.ing)}</td><td class="r" style="color:#a82c20">−${nf(tot.com)}</td><td class="r" style="color:${tot.margen >= 0 ? "#1c6b3e" : "#a82c20"}">${fmt(tot.margen)}</td></tr>`;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Resumen ${tipo} El Retiro</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#211b17;max-width:760px;margin:24px auto;padding:0 16px}
h1{color:#5a0f1c;margin:0 0 2px;font-size:24px;letter-spacing:-.02em}
.sub{color:#857a6e;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:18px}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
th{text-align:left;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#857a6e;border-bottom:2px solid #211b17;padding:8px 6px}
th.r,td.r{text-align:right}td{padding:8px 6px;border-bottom:1px solid #e7e0d4}td.r{font-family:monospace}
.tot td{border-top:2px solid #211b17;border-bottom:0;font-weight:bold}
.ft{color:#857a6e;font-size:11px;margin-top:20px}</style></head><body>
<h1>EL RETIRO</h1><div class="sub">Resumen ${tipo} · Arenera · Sol de Julio</div>
<table><thead><tr><th>Período</th><th class="r">Bateas</th><th class="r">Tn</th><th class="r">Ingreso</th><th class="r">Comisión</th><th class="r">Margen</th></tr></thead>
<tbody>${trs}${totRow}</tbody></table>
<div class="ft">Generado con El Retiro · ${new Date().toLocaleDateString("es-AR")}</div>
<script>window.onload=function(){window.print()}<\/script></body></html>`;
    const w = window.open("", "_blank");
    if (!w) { setImportErr("El navegador bloqueó la ventana. Permití las ventanas emergentes para exportar el PDF."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  // Saneo del respaldo: descarta lo que esté roto en vez de meter NaN a los totales.
  function sanitizarRegistros(arr) {
    const ok = []; let descartados = 0;
    for (const r of Array.isArray(arr) ? arr : []) {
      const b = parseFloat(r && r.bateas);
      const fechaOk = r && typeof r.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha);
      const modoOk = r && (r.modo === "bruta" || r.modo === "grillada");
      if (fechaOk && modoOk && b > 0) {
        ok.push({
          id: (r.id !== undefined && r.id !== null) ? r.id : newId(),
          fecha: r.fecha, modo: r.modo, bateas: b,
          clienteId: r.clienteId != null ? r.clienteId : "",
          cliente: typeof r.cliente === "string" && r.cliente ? r.cliente : "—",
          canal: r.canal === "Directo" ? "Directo" : "Intermediario",
          palaCliente: !!r.palaCliente,
          ...(r.econ && typeof r.econ === "object" ? { econ: r.econ } : {}),
        });
      } else descartados++;
    }
    return { ok, descartados };
  }
  function sanitizarClientes(arr) {
    const ok = []; let descartados = 0;
    for (const c of Array.isArray(arr) ? arr : []) {
      if (c && typeof c.nombre === "string" && c.nombre.trim()) {
        ok.push({
          id: (c.id !== undefined && c.id !== null) ? c.id : newId(),
          nombre: c.nombre.trim(),
          localidad: typeof c.localidad === "string" ? c.localidad : "",
          tel: typeof c.tel === "string" ? c.tel : "",
          canal: c.canal === "Directo" ? "Directo" : "Intermediario",
        });
      } else descartados++;
    }
    return { ok, descartados };
  }
  function sanitizarProgramadas(arr) {
    const ok = [];
    for (const p of Array.isArray(arr) ? arr : []) {
      const b = parseFloat(p && p.bateas);
      const fechaOk = p && typeof p.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.fecha);
      if (fechaOk && b > 0) {
        ok.push({
          id: (p.id !== undefined && p.id !== null) ? p.id : newId(),
          fecha: p.fecha, bateas: b,
          modo: p.modo === "grillada" ? "grillada" : "bruta",
          clienteId: p.clienteId != null ? p.clienteId : "",
          cliente: typeof p.cliente === "string" && p.cliente ? p.cliente : "—",
          canal: p.canal === "Directo" ? "Directo" : "Intermediario",
          nota: typeof p.nota === "string" ? p.nota : "",
          palaCliente: !!p.palaCliente,
        });
      }
    }
    return { ok };
  }

  function archivoElegido(e) {
    setImportErr("");
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.registros)) throw new Error();
        const reg = sanitizarRegistros(data.registros);
        const cli = sanitizarClientes(data.clientes);
        const prog = sanitizarProgramadas(data.programadas);
        setPendingImport({
          cfg: data.cfg && typeof data.cfg === "object" ? data.cfg : null,
          registros: reg.ok, clientes: cli.ok, programadas: prog.ok,
          descartados: reg.descartados + cli.descartados,
        });
      } catch { setImportErr("El archivo no es un respaldo válido de El Retiro."); }
    };
    reader.onerror = () => setImportErr("No se pudo leer el archivo.");
    reader.readAsText(file);
    e.target.value = "";
  }

  function confirmarImport() {
    if (!pendingImport) return;
    if (pendingImport.cfg) { const nc = { ...DEFAULTS, ...pendingImport.cfg }; setCfg(nc); setCfgDraft(nc); }
    setRegistros(pendingImport.registros);
    setClientes(pendingImport.clientes);
    setProgramadas(pendingImport.programadas);
    setPendingImport(null);
  }

  return (
    <div style={{ background: "transparent", minHeight: "100vh", color: C.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@500;600;700&display=swap');
        * { box-sizing: border-box; }
        html, body { margin: 0; }
        /* Fondo arena PLANO: el neumorfismo necesita superficie uniforme para que las sombras lean limpias */
        body { background:${C.bg}; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
        .app { font-family: Archivo, sans-serif; max-width: 1120px; margin: 0 auto; padding: 30px 20px 90px; }
        .label { font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:0.16em; text-transform:uppercase; color:${C.ink2}; font-weight:600; }
        .num { font-family:'IBM Plex Mono',monospace; font-weight:700; font-variant-numeric: tabular-nums; letter-spacing:-0.01em; }
        .row { display:flex; gap:14px; }
        /* NEUMORFISMO — superficie = fondo; volumen extruido con doble sombra (luz arriba-izq, oscura abajo-der) */
        .card { background:${C.bg}; border:0; border-radius:20px; padding:24px; box-shadow:9px 9px 20px ${C.dark}, -9px -9px 20px ${C.light}; }
        .kpi { padding:20px 18px; }
        .grid-kpi { display:grid; grid-template-columns:repeat(4,1fr); gap:18px; }
        .grid-2 { display:grid; grid-template-columns:1.05fr 0.95fr; gap:20px; }
        .grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; }
        .grid-form { display:grid; grid-template-columns:repeat(5,1fr); gap:14px; align-items:end; }
        /* Inputs HUNDIDOS (inset): se perciben como campos para llenar */
        .inputWrap { display:flex; align-items:center; border:0; border-radius:13px; background:${C.bg}; overflow:hidden; box-shadow:inset 3px 3px 6px ${C.dark}, inset -3px -3px 6px ${C.light}; transition:box-shadow .15s; }
        .input, select.input { width:100%; border:0; outline:0; padding:12px 14px; font-family:'IBM Plex Mono',monospace; font-size:15px; font-weight:600; color:${C.ink}; background:transparent; }
        .inputWrap:focus-within { box-shadow:inset 3px 3px 6px ${C.dark}, inset -3px -3px 6px ${C.light}, 0 0 0 2px ${C.accent}; }
        select.input { -webkit-appearance:none; appearance:none; cursor:pointer; }
        .selectWrap { position:relative; }
        .selectWrap::after { content:'▾'; position:absolute; right:14px; top:50%; transform:translateY(-50%); color:${C.accent}; pointer-events:none; }
        /* CTA primario: bordó sólido (máximo contraste sobre arena) con relieve; al apretar se hunde */
        .btn { font-family:'IBM Plex Mono',monospace; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; font-size:13px; border:0; border-radius:13px; padding:13px 20px; cursor:pointer; background:${C.accent}; color:#fff; box-shadow:5px 5px 12px ${C.dark}, -5px -5px 12px ${C.light}; transition:background .15s, box-shadow .12s, transform .05s; }
        .btn:hover { background:#6e1424; }
        .btn:active { background:#4d0c17; box-shadow:inset 3px 3px 7px rgba(0,0,0,0.4), inset -2px -2px 6px rgba(255,255,255,0.12); transform:translateY(1px); }
        /* Toggles en relieve; el estado activo queda presionado (inset) */
        .tog { font-family:'IBM Plex Mono',monospace; font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:0.05em; padding:11px 18px; border:0; border-radius:12px; background:${C.bg}; color:${C.ink2}; cursor:pointer; box-shadow:4px 4px 9px ${C.dark}, -4px -4px 9px ${C.light}; transition:.13s; }
        .tog:hover { color:${C.ink}; }
        .tog:active { box-shadow:inset 3px 3px 7px ${C.dark}, inset -3px -3px 7px ${C.light}; }
        .tog.on { background:${C.accent}; color:#fff; box-shadow:inset 3px 3px 7px rgba(0,0,0,0.38), inset -2px -2px 6px rgba(255,255,255,0.10); }
        .brk td { padding:9px 0; border-bottom:1px solid ${C.line}; font-size:14px; }
        .brk td:last-child { text-align:right; }
        table.reg { width:100%; border-collapse:collapse; font-size:13.5px; }
        table.reg th { text-align:left; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:0.12em; text-transform:uppercase; color:${C.ink2}; padding:11px 12px; border-bottom:2px solid ${C.line}; font-weight:600; }
        table.reg td { padding:12px; border-bottom:1px solid ${C.line}; }
        table.reg tbody tr { transition:background .12s; }
        table.reg tbody tr:hover { background:${C.accent}12; }
        .pill { font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:600; padding:3px 10px; border-radius:20px; letter-spacing:0.03em; }
        .del { border:0; background:transparent; color:${C.ink2}; cursor:pointer; font-size:18px; line-height:1; transition:color .15s; }
        .del:hover { color:${C.rojo}; }
        /* Navegación del calendario: botones redondos en relieve */
        .navbtn { border:0; background:${C.bg}; color:${C.ink}; cursor:pointer; width:36px; height:36px; border-radius:50%; font-size:18px; line-height:1; box-shadow:3px 3px 7px ${C.dark}, -3px -3px 7px ${C.light}; transition:.12s; }
        .navbtn:hover { color:${C.accent}; }
        .navbtn:active { box-shadow:inset 2px 2px 5px ${C.dark}, inset -2px -2px 5px ${C.light}; }
        .cal { display:grid; grid-template-columns:repeat(7,1fr); gap:9px; }
        .cal-h { font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:${C.ink2}; text-align:center; padding-bottom:2px; }
        /* Días vacíos hundidos; los días con carga sobresalen rellenos en bordó (estilo inline) */
        .cal-d { aspect-ratio:1; border:0; border-radius:12px; padding:7px; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; box-shadow:inset 2px 2px 5px ${C.dark}, inset -2px -2px 5px ${C.light}; }
        .cal-d.empty { box-shadow:none; }
        .barswrap { overflow-x:auto; }
        .bars { display:flex; align-items:flex-end; gap:12px; height:180px; min-width:100%; padding-top:18px; }
        .bar-col { flex:1; min-width:36px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; position:relative; }
        .bar { width:100%; border-radius:8px 8px 0 0; min-height:3px; box-shadow:3px 3px 7px ${C.dark}, -3px -3px 7px ${C.light}; transition:filter .15s; }
        .bar-col:hover .bar { filter:brightness(1.06); }
        header.brandhead { position:relative; }
        header.brandhead::after { content:''; position:absolute; left:0; bottom:-3px; width:128px; height:3px; background:${C.gold}; }
        @media (max-width:860px){
          .grid-kpi{ grid-template-columns:repeat(2,1fr);} .grid-2{ grid-template-columns:1fr;}
          .grid-3{ grid-template-columns:1fr;} .grid-form{ grid-template-columns:1fr 1fr;}
        }
        @media (max-width:560px){
          .cal { gap:4px; }
          .cal-d { padding:4px; border-radius:7px; }
          .app{ padding:16px 12px 64px; }
          .card{ padding:16px; border-radius:14px; }
          .grid-kpi{ grid-template-columns:1fr 1fr; gap:10px; }
          .grid-form{ grid-template-columns:1fr; gap:14px; }
          .grid-form > label[style*="span 2"]{ grid-column:auto; }
          .card > .row:first-child{ flex-wrap:wrap; }
          .input, select.input{ font-size:16px; padding:13px 12px; }  /* 16px evita el zoom de iOS */
          .btn{ width:100%; padding:14px; }
          header h1{ font-size:27px !important; }
          .card h2{ font-size:18px !important; }
          .kpi .num{ font-size:21px !important; }
          /* TABLAS -> TARJETAS APILADAS */
          table.reg thead{ display:none; }
          table.reg, table.reg tbody, table.reg tr, table.reg td{ display:block; width:100%; }
          table.reg tr{ border:1px solid ${C.line}; border-radius:12px; padding:4px 14px; margin-bottom:12px; }
          table.reg td{ border:0; border-bottom:1px solid ${C.line}; padding:11px 0; display:flex; justify-content:space-between; align-items:center; gap:16px; text-align:right; }
          table.reg td:last-child{ border-bottom:0; }
          table.reg td::before{ content:attr(data-label); font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:${C.ink2}; }
          table.reg td[data-label=""]{ justify-content:flex-end; }
        }
      `}</style>

      <div className="app">
        {/* HEADER */}
        <header className="brandhead" style={{ marginBottom: 26, paddingBottom: 20, borderBottom: `3px solid ${C.accent}` }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
            <div>
              {logoOk ? (
                <img src="/logo.png" alt="El Retiro" onError={() => setLogoOk(false)}
                  style={{ width: "min(240px, 64vw)", height: "auto", display: "block" }} />
              ) : (
                <h1 style={{ margin: 0, fontFamily: "Archivo, sans-serif", fontWeight: 800, fontSize: 38, letterSpacing: "-0.03em", color: C.accent }}>EL RETIRO</h1>
              )}
              <div className="label" style={{ color: C.accent, marginTop: 10 }}>Panel de control · Arenera · Sol de Julio</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
              <div className="row" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button className="tog" onClick={() => { if (!showCfg) { setCfgDraft(cfg); setCfgSaved(false); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {} } setShowCfg((s) => !s); }}>{showCfg ? "Ocultar supuestos" : "Editar supuestos"}</button>
                <button className="tog" onClick={() => signOut(auth)}>Cerrar sesión</button>
              </div>
              {user && user.email && (
                <span className="label" style={{ color: C.ink2, textTransform: "none", letterSpacing: 0 }}>{user.email}</span>
              )}
            </div>
          </div>
        </header>

        {/* ALERTAS */}
        {alertas.length > 0 && (
          <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>
            {alertas.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: `${a.color}10`, borderLeft: `4px solid ${a.color}`, borderRadius: 10, padding: "12px 16px" }}>
                <Dot color={a.color} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: C.ink }}>{a.t}</div>
                  <div style={{ fontSize: 13, color: C.ink2, marginTop: 2 }}>{a.d}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* CONFIGURACIÓN (arriba, al lado del botón) */}
        {showCfg && (
          <div style={{ marginBottom: 22 }}>
          <Section tag="Parámetros" title="Supuestos editables"
            right={<button className="tog" onClick={() => setCfgDraft({ ...DEFAULTS })}>Restablecer</button>}>
            <div className="grid-3" style={{ rowGap: 16 }}>
              <Field label="Precio bruta" value={cfgDraft.precioBruta} onChange={setD("precioBruta")} suffix="$/tn" step={100} />
              <Field label="Precio grillada" value={cfgDraft.precioGrillada} onChange={setD("precioGrillada")} suffix="$/tn" step={100} />
              <Field label="Comisión intermediario" value={cfgDraft.comisionSocios} onChange={setD("comisionSocios")} suffix="%" />
              <Field label="Tn por batea" value={cfgDraft.tnPorBatea} onChange={setD("tnPorBatea")} suffix="tn" />
              <Field label="Regalía" value={cfgDraft.regalia} onChange={setD("regalia")} suffix="%" />
              <Field label="Gasoil" value={cfgDraft.gasoilPrecio} onChange={setD("gasoilPrecio")} suffix="$/L" step={50} />
              <Field label="Consumo pala" value={cfgDraft.palaConsumo} onChange={setD("palaConsumo")} suffix="L/h" step={0.5} />
              <Field label="Reserva pala" value={cfgDraft.palaReserva} onChange={setD("palaReserva")} suffix="$/h" step={500} />
              <Field label="Bateas por jornada" value={cfgDraft.bateasPorDia} onChange={setD("bateasPorDia")} suffix="bat" step={1} />
              <Field label="Horas pala/jornada (bruta)" value={cfgDraft.horasPalaBruta} onChange={setD("horasPalaBruta")} suffix="h" step={0.5} />
              <Field label="Horas pala/jornada (grillada)" value={cfgDraft.horasPalaGrillada} onChange={setD("horasPalaGrillada")} suffix="h" step={0.5} />
              <Field label="Costo grilla" value={cfgDraft.costoGrilla} onChange={setD("costoGrilla")} suffix="$" step={50000} />
              <Field label="Empleado / mes (con cargas)" value={cfgDraft.empleadoMes} onChange={setD("empleadoMes")} suffix="$" step={10000} />
              <Field label="Días empleado / mes" value={cfgDraft.empleadoDiasMes} onChange={setD("empleadoDiasMes")} suffix="días" step={1} />
              <Field label="Días en la arenera" value={cfgDraft.empleadoDiasArena} onChange={setD("empleadoDiasArena")} suffix="días" step={1} />
              <Field label="Otros fijos / mes" value={cfgDraft.costosFijosMes} onChange={setD("costosFijosMes")} suffix="$" step={10000} />
            </div>
            <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 14, background: `${C.accent}0a`, borderRadius: 10, padding: "10px 14px", lineHeight: 1.5 }}>
              Del empleado, la arenera paga solo <b className="num" style={{ color: C.ink }}>{normCfg(cfgDraft).empleadoDiasArena || 0}</b> de <b>{normCfg(cfgDraft).empleadoDiasMes || 0}</b> días = <b className="num" style={{ color: C.ink }}>{$(empleadoArena(normCfg(cfgDraft)))}/mes</b> (el resto lo paga el otro trabajo). Con los otros fijos, son <b className="num" style={{ color: C.ink }}>{$(fijosMes(normCfg(cfgDraft)))}/mes</b> que se restan una vez al mes. La pala y los varios del día se reparten entre las <b>{normCfg(cfgDraft).bateasPorDia || 0}</b> bateas de la jornada.
            </div>
            <div className="row" style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${C.line}`, alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <button className="btn" style={{ background: cfgDirty ? C.accent : C.ink2, cursor: cfgDirty ? "pointer" : "default" }} disabled={!cfgDirty} onClick={guardarCfg}>Guardar supuestos</button>
              {cfgSaved && <span className="num" style={{ fontSize: 13, color: C.verde }}>✓ Guardado</span>}
              {!cfgSaved && cfgDirty && <span className="num" style={{ fontSize: 13, color: C.amarillo }}>Cambios sin guardar</span>}
              {!cfgSaved && !cfgDirty && <span style={{ fontSize: 13, color: C.ink2 }}>Los números de toda la app usan estos valores guardados.</span>}
            </div>
          </Section>
          </div>
        )}

        {/* KPIs */}
        <div className="grid-kpi" style={{ marginBottom: 22 }}>
          <Kpi label="Margen del mes" value={$(stats.margenMes)} sub={`${N(stats.tnMes)} tn cargadas`} color={semMar} />
          <Kpi label="Ventas directas" value={`${N(stats.pctDir)}%`} sub="cuanto más alto, más recuperás del 30%" color={semDir} />
          <Kpi label="Bateas este mes" value={`${stats.batMes} / ${objMes}`} sub="objetivo mensual" color={semBat} />
          <Kpi label="Comisión intermediario (mes)" value={$(stats.comMes)} sub="tu mayor costo" color={C.accent} />
        </div>

        {/* DECISIÓN + CALCULADORA */}
        <div className="grid-2" style={{ marginBottom: 18 }}>
          {/* Decisión */}
          <Section tag="Decisión" title="Bruta vs. grillada">
            <div style={{ display: "flex", alignItems: "center", gap: 16, background: `${dec.color}0d`, border: `1px solid ${dec.color}33`, borderRadius: 12, padding: "18px 20px", marginBottom: 18 }}>
              <Dot color={dec.color} />
              <div>
                <div className="num" style={{ fontSize: 19, color: dec.color }}>{dec.txt}</div>
                <div style={{ fontSize: 13, color: C.ink2, marginTop: 3 }}>{dec.msg}</div>
              </div>
            </div>
            <table style={{ width: "100%" }} className="brk">
              <tbody>
                <tr><td>Neto bruta</td><td className="num">{$(netoB)}/tn</td></tr>
                <tr><td>Neto grillada</td><td className="num">{$(netoG)}/tn</td></tr>
                <tr><td>Precio grillada para empatar</td><td className="num" style={{ color: C.accent }}>{$(beG)}/tn</td></tr>
                <tr><td>Piso de la bruta (pérdida)</td><td className="num">{$(beB)}/tn</td></tr>
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: C.ink2, marginTop: 12, lineHeight: 1.5 }}>
              La decisión bruta vs. grillada depende de los precios y costos (Editar supuestos), no de la cantidad: cada batea paga su parte justa del día. Cambiá el precio de grillada o un costo y el semáforo se recalcula.
            </div>
          </Section>

          {/* Calculadora del mes (plan dual bruta + grillada) */}
          <Section tag="Calculadora" title="Plan del mes">
            <div style={{ marginBottom: 14 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span className="label">Bateas bruta / mes</span>
                <span className="num" style={{ fontSize: 14.5, color: C.ink }}>{qBruta} · {N(diaB.tn)} tn · <span style={{ color: diaB.margen >= 0 ? C.verde : C.rojo }}>{$(diaB.margen)}</span></span>
              </div>
              <input type="range" min={0} max={40} value={qBruta} onChange={(e) => setQBruta(parseInt(e.target.value))}
                style={{ width: "100%", accentColor: C.accent }} aria-label="Bateas de bruta por mes" />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span className="label">Bateas grillada / mes</span>
                <span className="num" style={{ fontSize: 14.5, color: C.ink }}>{qGrillada} · {N(diaG.tn)} tn · <span style={{ color: diaG.margen >= 0 ? C.verde : C.rojo }}>{$(diaG.margen)}</span></span>
              </div>
              <input type="range" min={0} max={40} value={qGrillada} onChange={(e) => setQGrillada(parseInt(e.target.value))}
                style={{ width: "100%", accentColor: C.accent }} aria-label="Bateas de grillada por mes" />
            </div>
            <table style={{ width: "100%" }} className="brk">
              <tbody>
                <tr><td>Margen bruta</td><td className="num" style={{ color: diaB.margen >= 0 ? C.verde : C.rojo }}>{$(diaB.margen)}</td></tr>
                <tr><td>Margen grillada</td><td className="num" style={{ color: diaG.margen >= 0 ? C.verde : C.rojo }}>{$(diaG.margen)}</td></tr>
              </tbody>
            </table>

            <button className="tog" style={{ marginTop: 12 }} onClick={() => setVerDesgloseCalc((v) => !v)}>{verDesgloseCalc ? "Ocultar desglose" : "Ver desglose de costos"}</button>
            {verDesgloseCalc && (
              <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                {[{ lab: "Bruta", d: diaB, modo: "bruta", q: qBruta }, { lab: "Grillada", d: diaG, modo: "grillada", q: qGrillada }].map((x) => (
                  <div key={x.lab} style={{ background: `${C.accent}0a`, borderRadius: 10, padding: "10px 14px" }}>
                    <div className="label" style={{ marginBottom: 6 }}>{x.lab} · {x.q} bat · {N(x.d.tn)} tn</div>
                    <table style={{ width: "100%" }} className="brk">
                      <tbody>
                        <tr><td>Ingreso bruto</td><td className="num">{$(x.d.ingresoBruto)}</td></tr>
                        <tr><td>− Comisión intermediario ({cfg.comisionSocios}%)</td><td className="num" style={{ color: C.rojo }}>−{N(x.d.comision)}</td></tr>
                        <tr><td>− Regalía ({cfg.regalia}%)</td><td className="num" style={{ color: C.rojo }}>−{N(x.d.regaliaMonto)}</td></tr>
                        <tr><td>− Gasoil + reserva pala</td><td className="num" style={{ color: C.rojo }}>−{N(x.d.gasoil + x.d.reserva)}</td></tr>
                        <tr><td>− Varios</td><td className="num" style={{ color: C.rojo }}>−{N(x.d.varios)}</td></tr>
                        {x.modo === "grillada" && <tr><td>− Amortización grilla</td><td className="num" style={{ color: C.rojo }}>−{N(x.d.amortGrilla)}</td></tr>}
                        <tr><td style={{ fontWeight: 700 }}>Margen</td><td className="num" style={{ color: x.d.margen >= 0 ? C.verde : C.rojo, fontWeight: 700 }}>{$(x.d.margen)}</td></tr>
                        <tr><td>Margen por tn</td><td className="num">{$(x.d.margenTn)}/tn</td></tr>
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginTop: 14, paddingTop: 14, borderTop: `2px solid ${C.ink}` }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Margen de contribución</span>
              <span className="num" style={{ fontSize: 22, color: totalMargenMes >= 0 ? C.verde : C.rojo }}>{$(totalMargenMes)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: C.ink2, fontSize: 12.5, marginTop: 6 }}>
              <span>{N(totalTnMes)} tn en total</span><span>{qBruta + qGrillada} bateas</span>
            </div>
            {/* Resultado del mes: la contribución MENOS los fijos (se pagan cargues o no) */}
            <table style={{ width: "100%", marginTop: 12 }} className="brk">
              <tbody>
                <tr><td>− Empleado + fijos del mes</td><td className="num" style={{ color: C.rojo }}>−{N(fijosMes(cfg))}</td></tr>
                <tr><td style={{ fontWeight: 700, fontSize: 15 }}>Resultado del mes</td><td className="num" style={{ fontSize: 22, color: (totalMargenMes - fijosMes(cfg)) >= 0 ? C.verde : C.rojo }}>{$(totalMargenMes - fijosMes(cfg))}</td></tr>
              </tbody>
            </table>
            {fijosMes(cfg) === 0 && (
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 6 }}>Cargá "Empleado / mes" y "Otros fijos" en Editar supuestos para ver el resultado real.</div>
            )}

            {/* Avance del objetivo según propuestas guardadas */}
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <span className="label">Avance · propuestas</span>
                <span className="num" style={{ fontSize: 13, color: (propAgg.mB + propAgg.mG) >= 0 ? C.verde : C.rojo }}>{$(propAgg.mB + propAgg.mG)}</span>
              </div>
              {[{ lab: "Bruta", val: propAgg.bB, obj: qBruta, mar: propAgg.mB }, { lab: "Grillada", val: propAgg.bG, obj: qGrillada, mar: propAgg.mG }].map((x) => {
                const pct = x.obj > 0 ? Math.min(100, (x.val / x.obj) * 100) : 0;
                const ok = x.obj > 0 && x.val >= x.obj;
                return (
                  <div key={x.lab} style={{ marginBottom: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: C.ink }}>{x.lab}: <b className="num">{N(x.val)} / {x.obj}</b> bat</span>
                      <span className="num" style={{ fontSize: 12.5, color: ok ? C.verde : C.ink2 }}>{ok ? "✓ cumplido" : `${N(pct)}%`}</span>
                    </div>
                    <div style={{ height: 9, borderRadius: 6, background: C.bg, boxShadow: `inset 2px 2px 4px ${C.dark}, inset -2px -2px 4px ${C.light}`, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: ok ? C.verde : C.accent, borderRadius: 6, transition: "width .2s" }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 4 }}>
                {propuestas.length === 0 ? "Guardá propuestas y vas viendo cuánto del objetivo cubrís." : `${propuestas.length} propuesta(s) guardada(s).`}
              </div>
            </div>
          </Section>
        </div>

        {/* ANALIZAR PROPUESTA */}
        <Section tag="Propuesta" title="Analizar propuesta"
          right={<span className="label">{propuestas.length} guardadas</span>}>
          <div className="grid-form" style={{ marginBottom: 18 }}>
            <label style={{ display: "block", gridColumn: "span 2" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quién (opcional)</span>
              <div className="inputWrap"><input className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={prQuien} placeholder="Corralón San José…" onChange={(e) => setPrQuien(e.target.value)} /></div>
            </label>
            <Field label="Precio ofrecido" value={prPrecio} onChange={setPrPrecio} suffix="$/tn" />
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Modo</span>
              <div className="inputWrap selectWrap"><select className="input" value={prModo} onChange={(e) => setPrModo(e.target.value)}><option value="bruta">Bruta</option><option value="grillada">Grillada</option></select></div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Canal</span>
              <div className="inputWrap selectWrap"><select className="input" value={prCanal} onChange={(e) => setPrCanal(e.target.value)}><option>Directo</option><option>Intermediario</option></select></div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Pala</span>
              <div className="inputWrap selectWrap"><select className="input" value={prPalaCliente ? "cliente" : "propia"} onChange={(e) => setPrPalaCliente(e.target.value === "cliente")}><option value="propia">La pongo yo</option><option value="cliente">La trae el cliente</option></select></div>
            </label>
            <Field label="Bateas" value={prBateas} onChange={setBateasProp} suffix="bat" />
            <Field label="Toneladas" value={prTn} onChange={setTnProp} suffix="tn" />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16, background: `${prDec.color}0d`, border: `1px solid ${prDec.color}33`, borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
            <Dot color={prDec.color} />
            <div>
              <div className="num" style={{ fontSize: 19, color: prDec.color }}>{prDec.txt}</div>
              <div style={{ fontSize: 13, color: C.ink2, marginTop: 3 }}>{prDec.msg}</div>
            </div>
          </div>

          {prPrecioNum > 0 && prBateasNum > 0 && (
            <>
              <table style={{ width: "100%" }} className="brk">
                <tbody>
                  <tr><td>Ingreso bruto ({N(prEcon.tn)} tn × {$(prPrecioNum)})</td><td className="num">{$(prEcon.ingresoBruto)}</td></tr>
                  {prCanal !== "Directo"
                    ? <tr><td>− Comisión intermediario ({cfg.comisionSocios}%)</td><td className="num" style={{ color: C.rojo }}>−{N(prEcon.comision)}</td></tr>
                    : <tr><td>Comisión intermediario</td><td className="num" style={{ color: C.ink2 }}>venta directa</td></tr>}
                  <tr><td>− Regalía ({cfg.regalia}%)</td><td className="num" style={{ color: C.rojo }}>−{N(prEcon.regaliaMonto)}</td></tr>
                  <tr><td>− Gasoil + reserva pala</td><td className="num" style={{ color: C.rojo }}>−{N(prEcon.gasoil + prEcon.reserva)}</td></tr>
                  <tr><td>− Varios</td><td className="num" style={{ color: C.rojo }}>−{N(prEcon.varios)}</td></tr>
                  {prModo === "grillada" && <tr><td>− Amortización grilla</td><td className="num" style={{ color: C.rojo }}>−{N(prEcon.amortGrilla)}</td></tr>}
                  <tr><td style={{ fontWeight: 700 }}>Margen (te queda a vos)</td><td className="num" style={{ color: prEcon.margen >= 0 ? C.verde : C.rojo, fontWeight: 700 }}>{$(prEcon.margen)}</td></tr>
                  <tr><td>Margen por tn</td><td className="num">{$(prEcon.margenTn)}/tn</td></tr>
                  <tr><td>Piso para no perder</td><td className="num" style={{ color: C.accent }}>{$(prPiso)}/tn</td></tr>
                </tbody>
              </table>
              {prObjetivo > 0 && (
                <div style={{ marginTop: 12, background: `${C.accent}0a`, borderRadius: 10, padding: "12px 16px", fontSize: 13, color: C.ink2, lineHeight: 1.5 }}>
                  Cubre <b style={{ color: C.ink }}>{prBateasNum} de {prObjetivo}</b> bateas de {prModo} de tu plan del mes (<b style={{ color: C.ink }}>{N(prCobertura)}%</b>).
                </div>
              )}
            </>
          )}

          <div className="row" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={guardarPropuesta}>+ Guardar propuesta</button>
            <button className="tog" disabled={!(prPrecioNum > 0 && prBateasNum > 0)} onClick={() => exportarPropuestaPDF({ quien: prQuien.trim() || "—", fecha: todayISO(), modo: prModo, canal: prCanal, precio: prPrecioNum, bateas: prBateasNum, tn: prEcon.tn, econ: prEcon, piso: prPiso, veredicto: prVeredicto })}>↧ Exportar PDF</button>
          </div>

          {propuestas.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: 20 }}>
              <table className="reg">
                <thead><tr><th>Fecha</th><th>Quién</th><th>Modo</th><th>Canal</th><th style={{ textAlign: "right" }}>Precio</th><th style={{ textAlign: "right" }}>Tn</th><th style={{ textAlign: "right" }}>Margen</th><th>Veredicto</th><th></th></tr></thead>
                <tbody>
                  {propuestas.map((p) => {
                    const col = p.veredicto === "Conviene" ? C.verde : p.veredicto === "Al límite" ? C.amarillo : C.rojo;
                    const abierto = !!propExp[p.id];
                    const pe = p.econ || analizarPropuesta(cfg, p.modo, p.canal, p.precio, p.bateas);
                    const piso = p.piso != null ? p.piso : pisoPropuesta(cfg, p.modo, p.canal, p.bateas);
                    return (
                      <React.Fragment key={p.id}>
                      <tr>
                        <td data-label="Fecha" className="num" style={{ fontSize: 12.5 }}>{p.fecha}</td>
                        <td data-label="Quién">{p.quien}</td>
                        <td data-label="Modo"><span className="pill" style={{ background: p.modo === "grillada" ? `${C.accent}1a` : `${C.ink}0d`, color: p.modo === "grillada" ? C.accent : C.ink }}>{p.modo}</span></td>
                        <td data-label="Canal"><span className="pill" style={{ background: p.canal === "Directo" ? `${C.verde}1a` : `${C.amarillo}1a`, color: p.canal === "Directo" ? C.verde : C.amarillo }}>{p.canal === "Directo" ? "Directo" : "Intermediario"}</span></td>
                        <td data-label="Precio" className="num" style={{ textAlign: "right" }}>{$(p.precio)}</td>
                        <td data-label="Tn" className="num" style={{ textAlign: "right" }}>{N(p.tn)}</td>
                        <td data-label="Margen" className="num" style={{ textAlign: "right", color: p.margen >= 0 ? C.verde : C.rojo }}>{$(p.margen)}</td>
                        <td data-label="Veredicto"><span className="pill" style={{ background: `${col}1a`, color: col }}>{p.veredicto}</span></td>
                        <td data-label="" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="del" title={abierto ? "Ocultar detalle" : "Ver detalle"} aria-label="Ver detalle" style={{ marginRight: 4, color: abierto ? C.accent : undefined }} onClick={() => setPropExp((m) => ({ ...m, [p.id]: !m[p.id] }))}>{abierto ? "▴" : "▾"}</button>
                          <button className="del" title="Exportar PDF" aria-label="Exportar PDF" style={{ marginRight: 4 }} onClick={() => exportarPropuestaPDF(p)}>↧</button>
                          <button className="del" title="Eliminar" aria-label="Eliminar propuesta" onClick={() => borrarPropuesta(p.id)}>×</button>
                        </td>
                      </tr>
                      {abierto && (
                        <tr>
                          <td data-label="" colSpan={9} style={{ display: "block", background: `${C.accent}0a`, borderRadius: 10, padding: "6px 16px 12px", margin: "0 0 4px" }}>
                            <table style={{ width: "100%" }} className="brk">
                              <tbody>
                                <tr><td>Ingreso bruto ({N(pe.tn)} tn × {$(p.precio)})</td><td className="num">{$(pe.ingresoBruto)}</td></tr>
                                {p.canal !== "Directo"
                                  ? <tr><td>− Comisión intermediario</td><td className="num" style={{ color: C.rojo }}>−{N(pe.comision)}</td></tr>
                                  : <tr><td>Comisión intermediario</td><td className="num" style={{ color: C.ink2 }}>venta directa</td></tr>}
                                <tr><td>− Regalía</td><td className="num" style={{ color: C.rojo }}>−{N(pe.regaliaMonto)}</td></tr>
                                <tr><td>− Gasoil + reserva pala</td><td className="num" style={{ color: C.rojo }}>−{N(pe.gasoil + pe.reserva)}</td></tr>
                                <tr><td>− Varios</td><td className="num" style={{ color: C.rojo }}>−{N(pe.varios)}</td></tr>
                                {p.modo === "grillada" && <tr><td>− Amortización grilla</td><td className="num" style={{ color: C.rojo }}>−{N(pe.amortGrilla)}</td></tr>}
                                <tr><td style={{ fontWeight: 700 }}>Margen (te queda a vos)</td><td className="num" style={{ color: pe.margen >= 0 ? C.verde : C.rojo, fontWeight: 700 }}>{$(pe.margen)}</td></tr>
                                <tr><td>Margen por tn</td><td className="num">{$(pe.margenTn)}/tn</td></tr>
                                <tr><td>Piso para no perder</td><td className="num" style={{ color: C.accent }}>{$(piso)}/tn</td></tr>
                              </tbody>
                            </table>
                            <button className="tog" style={{ marginTop: 12 }} onClick={() => exportarPropuestaPDF(p)}>↧ Exportar PDF</button>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* CLIENTES */}
        <Section tag="Cartera" title="Clientes"
          right={<span className="label">{clientes.length} cargados</span>}>
          <div className="grid-form" style={{ marginBottom: 20 }}>
            <label style={{ display: "block", gridColumn: "span 2" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Nombre</span>
              <div className="inputWrap">
                <input className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={cNombre} placeholder="Corralón San José…" onChange={(e) => setCNombre(e.target.value)} />
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Localidad</span>
              <div className="inputWrap">
                <input className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={cLocalidad} placeholder="Ojo de Agua…" onChange={(e) => setCLocalidad(e.target.value)} />
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Teléfono</span>
              <div className="inputWrap">
                <input className="input" value={cTel} placeholder="—" onChange={(e) => setCTel(e.target.value)} />
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Canal</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={cCanal} onChange={(e) => setCCanal(e.target.value)}>
                  <option>Intermediario</option><option>Directo</option>
                </select>
              </div>
            </label>
            <button className="btn" onClick={agregarCliente}>+ Agregar</button>
          </div>

          {clientes.length === 0 ? (
            <div style={{ color: C.ink2, fontSize: 14, padding: "16px 0" }}>Cargá tus corralones y clientes acá. Después los elegís de la lista al registrar cada venta y la app te arma el historial de cada uno.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="reg">
                <thead><tr><th>Cliente</th><th>Localidad</th><th>Canal</th><th>Tel</th><th style={{ textAlign: "right" }}>Tn total</th><th style={{ textAlign: "right" }}>Margen</th><th style={{ textAlign: "right" }}>Cargas</th><th>Última</th><th></th></tr></thead>
                <tbody>
                  {clientesStats.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Cliente" style={{ fontWeight: 600 }}>{c.nombre}</td>
                      <td data-label="Localidad" style={{ color: C.ink2 }}>{c.localidad || "—"}</td>
                      <td data-label="Canal"><span className="pill" style={{ background: c.canal === "Directo" ? `${C.verde}1a` : `${C.amarillo}1a`, color: c.canal === "Directo" ? C.verde : C.amarillo }}>{c.canal === "Directo" ? "Directo" : "Intermediario"}</span></td>
                      <td data-label="Tel" className="num" style={{ fontSize: 12.5 }}>{c.tel || "—"}</td>
                      <td data-label="Tn total" className="num" style={{ textAlign: "right" }}>{N(c.tn)}</td>
                      <td data-label="Margen" className="num" style={{ textAlign: "right", color: c.margen > 0 ? C.verde : C.ink2 }}>{$(c.margen)}</td>
                      <td data-label="Cargas" className="num" style={{ textAlign: "right" }}>{c.cargas}</td>
                      <td data-label="Última" className="num" style={{ fontSize: 12.5 }}>{c.ultima || "—"}</td>
                      <td data-label="" style={{ textAlign: "right" }}><button className="del" onClick={() => borrarCliente(c.id)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* CARGAS PROGRAMADAS */}
        <Section tag="Agenda" title="Cargas programadas"
          right={<span className="label">{programadas.length} en agenda</span>}>
          <div className="grid-form" style={{ marginBottom: 20 }}>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Día</span>
              <div className="inputWrap">
                <input className="input" type="date" value={pFecha} onChange={(e) => setPFecha(e.target.value)} />
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Cliente</span>
              <div className="inputWrap selectWrap">
                <select className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={pClienteId} onChange={(e) => setPClienteId(e.target.value)}>
                  <option value="">{clientes.length ? "Elegí…" : "Agregá un cliente ↓"}</option>
                  {clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.localidad ? ` · ${c.localidad}` : ""}</option>)}
                </select>
              </div>
            </label>
            <Field label="Bateas" value={pBateas} onChange={setPBateas} />
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Modo</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={pModo} onChange={(e) => setPModo(e.target.value)}>
                  <option value="bruta">Bruta</option><option value="grillada">Grillada</option>
                </select>
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Pala</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={pPalaCliente ? "cliente" : "propia"} onChange={(e) => setPPalaCliente(e.target.value === "cliente")}>
                  <option value="propia">La pongo yo</option><option value="cliente">La trae el cliente</option>
                </select>
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Nota</span>
              <div className="inputWrap">
                <input className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={pNota} placeholder="opcional…" onChange={(e) => setPNota(e.target.value)} />
              </div>
            </label>
          </div>
          <button className="btn" style={{ marginBottom: 18 }} onClick={programar}>+ Programar carga</button>

          {programadasSort.length === 0 ? (
            <div style={{ color: C.ink2, fontSize: 14, padding: "8px 0" }}>No tenés cargas agendadas. Programá la próxima arriba y mandásela al palero.</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {programadasSort.map((p) => {
                const hoy = todayISO();
                const estado = p.fecha < hoy ? { c: C.rojo, t: "Pendiente de confirmar" } : p.fecha === hoy ? { c: C.amarillo, t: "Es hoy" } : { c: C.accent, t: "Programada" };
                const tn = (parseFloat(p.bateas) || 0) * cfg.tnPorBatea;
                return (
                  <div key={p.id} style={{ border: `1px solid ${C.line}`, borderLeft: `4px solid ${estado.c}`, borderRadius: 12, padding: "14px 16px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 180 }}>
                      <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 4 }}>
                        <span className="num" style={{ fontSize: 15, color: C.ink }}>{fechaCorta(p.fecha)}</span>
                        <span className="pill" style={{ background: `${estado.c}1a`, color: estado.c }}>{estado.t}</span>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 14.5 }}>{p.cliente}</div>
                      <div className="num" style={{ fontSize: 12.5, color: C.ink2, marginTop: 2 }}>{p.bateas} batea(s) · {p.modo} · {N(tn)} tn</div>
                      {p.nota && <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 4, fontStyle: "italic" }}>“{p.nota}”</div>}
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <button className="tog" onClick={() => enviarOperario(p)}>Enviar al palero</button>
                      <button className="tog" style={{ background: C.verde, color: "#fff", borderColor: C.verde }} onClick={() => registrarProgramada(p)}>Se hizo → registrar</button>
                      <button className="tog" onClick={() => descartarProgramada(p.id)}>No se hizo</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* REGISTRO DE CARGAS */}
        <Section tag="Operación" title={editId ? "Editar carga" : "Registro de cargas"}
          right={editId ? <span className="pill" style={{ background: `${C.accent}1a`, color: C.accent }}>Editando</span> : null}>
          <div id="form-registro" className="grid-form" style={{ marginBottom: 20 }}>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Fecha</span>
              <div className="inputWrap">
                <input className="input" type="date" value={fFecha} onChange={(e) => setFFecha(e.target.value)} />
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Modo</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={fModo} onChange={(e) => setFModo(e.target.value)}>
                  <option value="bruta">Bruta</option><option value="grillada">Grillada</option>
                </select>
              </div>
            </label>
            <Field label="Bateas" value={fBateas} onChange={setFBateas} />
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Cliente</span>
              <div className="inputWrap selectWrap">
                <select className="input" style={{ fontFamily: "Archivo, sans-serif" }} value={fClienteId} onChange={(e) => elegirCliente(e.target.value)}>
                  <option value="">{clientes.length ? "Elegí…" : "Agregá un cliente ↓"}</option>
                  {clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.localidad ? ` · ${c.localidad}` : ""}</option>)}
                </select>
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Canal</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={fCanal} onChange={(e) => setFCanal(e.target.value)}>
                  <option>Intermediario</option><option>Directo</option>
                </select>
              </div>
            </label>
            <label style={{ display: "block" }}>
              <span style={{ display: "block", fontSize: 11.5, color: C.ink2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Pala</span>
              <div className="inputWrap selectWrap">
                <select className="input" value={fPalaCliente ? "cliente" : "propia"} onChange={(e) => setFPalaCliente(e.target.value === "cliente")}>
                  <option value="propia">La pongo yo</option><option value="cliente">La trae el cliente</option>
                </select>
              </div>
            </label>
          </div>
          <div className="row" style={{ marginBottom: 18, gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={registrar}>{editId ? "Guardar cambios" : "+ Registrar carga"}</button>
            {editId && <button className="tog" onClick={resetFormCarga}>Cancelar</button>}
          </div>

          {registros.length === 0 ? (
            <div style={{ color: C.ink2, fontSize: 14, padding: "16px 0" }}>Todavía no cargaste ninguna operación. Registrá la primera arriba.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="reg">
                <thead><tr><th>Fecha</th><th>Modo</th><th>Bateas</th><th>Tn</th><th>Cliente</th><th>Canal</th><th style={{ textAlign: "right" }}>Margen</th><th></th></tr></thead>
                <tbody>
                  {registros.map((r) => {
                    const c = econDe(r);
                    return (
                      <tr key={r.id}>
                        <td data-label="Fecha" className="num" style={{ fontSize: 12.5 }}>{r.fecha}</td>
                        <td data-label="Modo"><span className="pill" style={{ background: r.modo === "grillada" ? `${C.accent}1a` : `${C.ink}0d`, color: r.modo === "grillada" ? C.accent : C.ink }}>{r.modo}</span></td>
                        <td data-label="Bateas" className="num">{r.bateas}</td>
                        <td data-label="Tn" className="num">{N(c.tn)}</td>
                        <td data-label="Cliente">{r.cliente}</td>
                        <td data-label="Canal"><span className="pill" style={{ background: r.canal === "Directo" ? `${C.verde}1a` : `${C.amarillo}1a`, color: r.canal === "Directo" ? C.verde : C.amarillo }}>{r.canal === "Directo" ? "Directo" : "Intermediario"}</span></td>
                        <td data-label="Margen" className="num" style={{ textAlign: "right", color: c.margen >= 0 ? C.verde : C.rojo }}>{$(c.margen)}</td>
                        <td data-label="" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="del" title="Editar" aria-label="Editar carga" style={{ marginRight: 4, color: r.id === editId ? C.accent : undefined }} onClick={() => editar(r)}>✎</button>
                          <button className="del" title="Eliminar" aria-label="Eliminar carga" onClick={() => borrar(r.id)}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* RESUMEN POR MES */}
        <Section tag="Resumen" title="Mes por mes"
          right={
            <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button className="tog" onClick={() => exportarResumenPDF("mensual")}>↧ PDF mensual</button>
              <button className="tog" onClick={() => exportarResumenPDF("semanal")}>↧ PDF semanal</button>
            </div>
          }>
          {resumenMeses.length === 0 ? (
            <div style={{ color: C.ink2, fontSize: 14, padding: "8px 0" }}>El resumen se arma solo a medida que registrás cargas.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="reg">
                <thead><tr><th>Mes</th><th style={{ textAlign: "right" }}>Bateas</th><th style={{ textAlign: "right" }}>Tn</th><th style={{ textAlign: "right" }}>Ingreso</th><th style={{ textAlign: "right" }}>Comisión</th><th style={{ textAlign: "right" }}>Margen</th></tr></thead>
                <tbody>
                  {resumenMeses.map((m) => (
                    <tr key={m.key}>
                      <td data-label="Mes" style={{ fontWeight: 600 }}>{mesLabel(m.key)}</td>
                      <td data-label="Bateas" className="num" style={{ textAlign: "right" }}>{m.bateas}</td>
                      <td data-label="Tn" className="num" style={{ textAlign: "right" }}>{N(m.tn)}</td>
                      <td data-label="Ingreso" className="num" style={{ textAlign: "right" }}>{$(m.bruto)}</td>
                      <td data-label="Comisión" className="num" style={{ textAlign: "right", color: C.rojo }}>−{N(m.comision)}</td>
                      <td data-label="Margen" className="num" style={{ textAlign: "right", color: m.margen >= 0 ? C.verde : C.rojo, fontWeight: 700 }}>{$(m.margen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* CALENDARIO */}
        <Section tag="Calendario" title="Días de carga"
          right={
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <button className="navbtn" onClick={() => calNav(-1)}>‹</button>
              <span className="num" style={{ fontSize: 13, minWidth: 104, textAlign: "center" }}>{MESES_LARGO[cal.m]} {cal.y}</span>
              <button className="navbtn" onClick={() => calNav(1)}>›</button>
            </div>
          }>
          <div className="cal" style={{ marginBottom: 8 }}>
            {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((d) => <div key={d} className="cal-h">{d}</div>)}
            {Array.from({ length: calData.offset }).map((_, i) => <div key={"e" + i} className="cal-d empty" />)}
            {Array.from({ length: calData.ndays }).map((_, i) => {
              const day = i + 1;
              const info = calData.days[day];
              const ratio = info ? info.tn / calData.maxTn : 0;
              const alpha = info ? 0.6 + 0.4 * ratio : 0;
              return (
                <div key={day} className="cal-d"
                  title={info ? `${N(info.tn)} tn · ${info.bateas} bateas` : ""}
                  style={{ background: info ? `rgba(90,15,28,${alpha})` : C.bg, borderColor: info ? C.accent : C.line }}>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, color: info ? "#fff" : C.ink2 }}>{day}</span>
                  {info && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, fontWeight: 700, color: "#fff", lineHeight: 1.1 }}>{N(info.tn)} tn</span>}
                </div>
              );
            })}
          </div>
          <div style={{ color: C.ink2, fontSize: 12.5, marginTop: 12 }}>
            Total del mes: <span className="num" style={{ color: C.ink }}>{N(calData.tnMes)} tn</span>. Más oscuro = más toneladas ese día.
          </div>
        </Section>

        {/* TABLERO DE PICOS */}
        <Section tag="Tablero" title="Picos de extracción"
          right={<span className="label">tn por mes</span>}>
          {picos.arr.length === 0 ? (
            <div style={{ color: C.ink2, fontSize: 14, padding: "8px 0" }}>Cuando tengas cargas en distintos meses, vas a ver acá las barras y el mes pico.</div>
          ) : (
            <div className="barswrap">
              <div className="bars">
                {picos.arr.map((m) => {
                  const h = Math.max(3, (m.tn / picos.max) * 150);
                  const esPico = m.tn === picos.max;
                  return (
                    <div key={m.key} className="bar-col" title={`${mesLabel(m.key)} · ${N(m.tn)} tn`}>
                      <span className="num" style={{ fontSize: 10.5, color: esPico ? C.accent : C.ink2, marginBottom: 4, fontWeight: 700 }}>{N(m.tn)}</span>
                      <div className="bar" style={{ height: h, background: esPico ? C.accent : `${C.accent}40` }} />
                      <span className="num" style={{ fontSize: 9.5, color: C.ink2, marginTop: 6, textAlign: "center" }}>{MESES[parseInt(m.key.split("-")[1]) - 1]}<br />{m.key.split("-")[0].slice(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Section>

        {/* PROYECCIÓN */}
        <Section tag="Proyección" title={`Si cargás ${qBruta} bruta + ${qGrillada} grillada por mes`}>
          <div className="grid-3">
            <Kpi label="Por semana" value={$(proySem)} sub="≈ mes ÷ 4,33" color={C.accent} />
            <Kpi label="Por mes" value={$(proyMes)} sub="margen de contribución" color={C.accent} />
            <Kpi label="Por año" value={$(proyAnio)} sub="12 meses" color={C.accent} />
          </div>
          {fijosMes(cfg) > 0 && (() => {
            const fm = fijosMes(cfg);
            const bat = qBruta + qGrillada;
            const contribPorBatea = bat > 0 ? totalMargenMes / bat : 0;
            const minBateas = contribPorBatea > 0 ? Math.ceil(fm / contribPorBatea) : Infinity;
            return (
              <>
                <table style={{ width: "100%", marginTop: 16 }} className="brk">
                  <tbody>
                    <tr><td>Margen de contribución del mes</td><td className="num">{$(proyMes)}</td></tr>
                    <tr><td>− Empleado + otros fijos (los pagás cargues o no)</td><td className="num" style={{ color: C.rojo }}>−{N(fm)}</td></tr>
                    <tr><td style={{ fontWeight: 700 }}>Resultado del mes</td><td className="num" style={{ fontWeight: 700, color: (proyMes - fm) >= 0 ? C.verde : C.rojo }}>{$(proyMes - fm)}</td></tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 10, background: `${C.accent}0a`, borderRadius: 10, padding: "10px 14px" }}>
                  Para cubrir los costos fijos necesitás cargar al menos <b className="num" style={{ color: C.ink }}>{isFinite(minBateas) ? minBateas : "—"}</b> bateas/mes (con el mix actual). De ahí para arriba, ganás.
                </div>
              </>
            );
          })()}
        </Section>

        {/* RESPALDO */}
        <Section tag="Datos" title="Respaldo"
          right={<span className="label">{registros.length} cargas · {clientes.length} clientes</span>}>
          <div style={{ color: C.ink2, fontSize: 13.5, marginBottom: 16, lineHeight: 1.5 }}>
            Exportá un archivo con todas tus cargas y clientes para tenerlo a salvo (guardalo en el teléfono o mandátelo por WhatsApp). Si cambiás de celular o se borran los datos, lo importás y recuperás todo.
          </div>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={exportar}>↓ Exportar respaldo</button>
            <button className="btn" style={{ background: C.bg, color: C.ink, border: `1px solid ${C.line}` }} onClick={() => document.getElementById("importFile").click()}>↑ Importar respaldo</button>
            <input id="importFile" type="file" accept="application/json,.json" style={{ display: "none" }} onChange={archivoElegido} />
          </div>

          {importErr && <div style={{ marginTop: 14, color: C.rojo, fontSize: 13, fontWeight: 600 }}>{importErr}</div>}

          {pendingImport && (
            <div style={{ marginTop: 14, background: `${C.amarillo}12`, borderLeft: `4px solid ${C.amarillo}`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>¿Reemplazar los datos actuales?</div>
              <div style={{ fontSize: 13, color: C.ink2, margin: "4px 0 12px" }}>
                El respaldo trae {pendingImport.registros.length} cargas y {(pendingImport.clientes || []).length} clientes. Esto reemplaza lo que tenés ahora en este dispositivo.
                {pendingImport.descartados > 0 && (
                  <span style={{ display: "block", marginTop: 6, color: C.rojo, fontWeight: 600 }}>
                    Se ignoraron {pendingImport.descartados} registro(s) con datos inválidos.
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn" style={{ background: C.accent, width: "auto" }} onClick={confirmarImport}>Confirmar</button>
                <button className="tog" onClick={() => setPendingImport(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </Section>

        <footer style={{ marginTop: 28, color: C.ink2, fontSize: 12, fontFamily: "'IBM Plex Mono',monospace", letterSpacing: "0.04em" }}>
          Los supuestos se aplican al apretar Guardar. Datos guardados en tu cuenta (Firebase) y sincronizados entre tus dispositivos.
        </footer>
      </div>

      {/* TOAST DESHACER */}
      {undo && (
        <div role="status" aria-live="polite" style={{
          position: "fixed", left: "50%", bottom: 22, transform: "translateX(-50%)", zIndex: 60,
          display: "flex", alignItems: "center", gap: 16, maxWidth: "calc(100vw - 32px)",
          background: C.bg, borderRadius: 14, padding: "12px 16px",
          boxShadow: `6px 6px 14px ${C.dark}, -6px -6px 14px ${C.light}`,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{undo.msg}</span>
          <button className="tog" style={{ padding: "8px 14px" }} onClick={deshacer}>Deshacer</button>
        </div>
      )}
    </div>
  );
}
