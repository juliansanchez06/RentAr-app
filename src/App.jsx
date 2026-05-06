import { useState, useEffect, useMemo } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp, where
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC8rbF5yeSwTHCPG3Cbj7Dlo2_kRqHKq6U",
  authDomain: "rentar-5ca25.firebaseapp.com",
  projectId: "rentar-5ca25",
  storageBucket: "rentar-5ca25.firebasestorage.app",
  messagingSenderId: "133959848372",
  appId: "1:133959848372:web:addb25176532c5c45ca2e1"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ── Utils ────────────────────────────────────────────────────────────────────
const fARS = n => "$" + Math.round(n || 0).toLocaleString("es-AR");
const fUSD = n => "u$s " + Math.round(n || 0).toLocaleString("es-AR");
const fPct = n => (n || 0).toFixed(1) + "%";
const arsToUsd = (ars, tc) => tc > 0 ? Math.round((ars / tc) * 100) / 100 : 0;
const todayStr = () => new Date().toISOString().split("T")[0];
const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const MONTHS_FULL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DAYS = ["D","L","M","X","J","V","S"];

function calcIRR(inv, annual, terminal, yrs) {
  if (annual <= 0 || inv <= 0) return 0;
  let r = 0.08;
  for (let i = 0; i < 300; i++) {
    let npv = -inv, dn = 0;
    for (let t = 1; t <= yrs; t++) {
      const d = Math.pow(1 + r, t);
      npv += annual / d;
      dn -= (t * annual) / Math.pow(1 + r, t + 1);
    }
    npv += terminal / Math.pow(1 + r, yrs);
    dn -= (yrs * terminal) / Math.pow(1 + r, yrs + 1);
    if (Math.abs(dn) < 1e-6) break;
    const nr = r - npv / dn;
    if (Math.abs(nr - r) < 1e-5) break;
    r = nr;
  }
  return Math.max(r * 100, 0);
}

function calcPricing(nights, base, clean) {
  let rate = base, label = "Estándar";
  if (nights === 1) { rate = base * 1.2; label = "+20% tarifa 1 noche"; }
  else if (nights >= 7) { rate = base * 0.9; label = "-10% descuento semanal"; }
  return { total: Math.round(rate * nights + clean), perNight: Math.round(rate), label };
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg: "#0f1117",
  bgCard: "#1a1d27",
  bgCardHover: "#1e2130",
  bgInput: "#13151f",
  border: "#2a2d3e",
  borderLight: "#343750",
  text: "#e8eaf6",
  textSec: "#8b8fa8",
  textMuted: "#555870",
  green: "#00d97e",
  greenDark: "#00a85a",
  greenBg: "rgba(0,217,126,0.08)",
  greenBorder: "rgba(0,217,126,0.2)",
  yellow: "#ffd95a",
  yellowBg: "rgba(255,217,90,0.08)",
  yellowBorder: "rgba(255,217,90,0.2)",
  red: "#ff5c7a",
  redBg: "rgba(255,92,122,0.08)",
  redBorder: "rgba(255,92,122,0.2)",
  blue: "#4d9fff",
  blueBg: "rgba(77,159,255,0.08)",
  purple: "#a78bfa",
  purpleBg: "rgba(167,139,250,0.08)",
};

const S = {
  card: {
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 24,
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    background: C.bgInput,
    color: C.text,
    fontSize: 14,
    boxSizing: "border-box",
    outline: "none",
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: C.textSec,
    display: "block",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  btn: {
    background: C.green,
    color: "#0a0c12",
    border: "none",
    borderRadius: 10,
    padding: "11px 20px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },
  btnSec: {
    background: "transparent",
    color: C.textSec,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "10px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  modal: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(4px)",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalBox: {
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 520,
    maxHeight: "90vh",
    overflowY: "auto",
  },
};

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "⬛" },
  { id: "properties", label: "Propiedades", icon: "🏠" },
  { id: "bookings", label: "Reservas", icon: "📅" },
  { id: "transactions", label: "Transacciones", icon: "💳" },
  { id: "analytics", label: "Análisis", icon: "📊" },
];

// ════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [properties, setProperties] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [tc, setTc] = useState(1420);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [ps, ts, bs] = await Promise.all([
          getDocs(query(collection(db, "re_properties"), orderBy("createdAt", "desc"))),
          getDocs(query(collection(db, "re_transactions"), orderBy("date", "desc"))),
          getDocs(query(collection(db, "re_bookings"), orderBy("checkIn", "desc"))),
        ]);
        setProperties(ps.docs.map(d => ({ id: d.id, ...d.data() })));
        setTransactions(ts.docs.map(d => ({ id: d.id, ...d.data() })));
        setBookings(bs.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  async function reload() {
    const [ps, ts, bs] = await Promise.all([
      getDocs(query(collection(db, "re_properties"), orderBy("createdAt", "desc"))),
      getDocs(query(collection(db, "re_transactions"), orderBy("date", "desc"))),
      getDocs(query(collection(db, "re_bookings"), orderBy("checkIn", "desc"))),
    ]);
    setProperties(ps.docs.map(d => ({ id: d.id, ...d.data() })));
    setTransactions(ts.docs.map(d => ({ id: d.id, ...d.data() })));
    setBookings(bs.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  const shared = { properties, transactions, bookings, tc, reload, db };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: "'Inter', system-ui, sans-serif", color: C.text }}>
      
      {/* Sidebar */}
      <aside style={{
        width: 220, background: C.bgCard, borderRight: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column", position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50,
      }}>
        {/* Logo */}
        <div style={{ padding: "28px 20px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: `linear-gradient(135deg, ${C.green}, ${C.blue})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, fontWeight: 900, color: "#0a0c12",
            }}>R</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.5px" }}>
                Rent<span style={{ color: C.green }}>Ar</span>
              </div>
              <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "1px" }}>GESTIÓN INMOBILIARIA</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "11px 14px", borderRadius: 10, border: "none", cursor: "pointer",
              background: page === n.id ? C.greenBg : "transparent",
              color: page === n.id ? C.green : C.textSec,
              fontSize: 14, fontWeight: page === n.id ? 600 : 400,
              transition: "all 0.15s",
              borderLeft: page === n.id ? `2px solid ${C.green}` : "2px solid transparent",
              textAlign: "left", width: "100%",
            }}>
              <span style={{ fontSize: 16 }}>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        {/* TC Widget */}
        <div style={{ padding: 16, borderTop: `1px solid ${C.border}` }}>
          <div style={{
            background: C.bgInput, borderRadius: 12, padding: "12px 14px",
            border: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, letterSpacing: "1px", textTransform: "uppercase" }}>Dólar MEP</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.textMuted, fontSize: 14 }}>$</span>
              <input
                type="number" value={tc}
                onChange={e => setTc(Number(e.target.value))}
                style={{ ...S.input, padding: 0, border: "none", background: "transparent", fontSize: 20, fontWeight: 700, color: C.green, width: "100%" }}
              />
            </div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>ARS por USD · editable</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, marginLeft: 220, padding: 32, minHeight: "100vh" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh", flexDirection: "column", gap: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", border: `3px solid ${C.border}`, borderTopColor: C.green, animation: "spin 0.8s linear infinite" }} />
            <div style={{ color: C.textSec, fontSize: 14 }}>Cargando datos...</div>
          </div>
        ) : page === "dashboard" ? <Dashboard {...shared} />
          : page === "properties" ? <Properties {...shared} />
          : page === "bookings" ? <Bookings {...shared} />
          : page === "transactions" ? <Transactions {...shared} />
          : <Analytics {...shared} />}
      </main>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: ${C.bg}; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; borderRadius: 3px; }
        select option { background: ${C.bgCard}; }
      `}</style>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function Dashboard({ properties, transactions, bookings, tc }) {
  const [nights, setNights] = useState(12);
  const now = new Date();

  const d1 = properties.find(p => p.type === "fixed_rental");
  const d2 = properties.find(p => p.type === "short_term");

  const inc1ARS = d1
    ? (transactions.filter(t => t.propertyId === d1.id && t.type === "income").reduce((s,t) => s + t.amountARS, 0) / 3) || 476670
    : 476670;
  const exp1USD = 40;
  const inc1USD = arsToUsd(inc1ARS, tc);
  const net1USD = inc1USD - exp1USD;
  const val1 = d1?.estimatedValueUSD || 67000;
  const cap1 = val1 > 0 ? (net1USD * 12 / val1) * 100 : 0;
  const pb1 = net1USD > 0 ? val1 / (net1USD * 12) : null;

  const inc2ARS = 70000 * nights;
  const inc2USD = arsToUsd(inc2ARS, tc);
  const net2USD = inc2USD - 20;
  const val2 = d2?.estimatedValueUSD || 57000;
  const cap2 = val2 > 0 ? (net2USD * 12 / val2) * 100 : 0;
  const pb2 = net2USD > 0 ? val2 / (net2USD * 12) : null;

  const totalVal = val1 + val2;
  const totalNet = net1USD + net2USD;
  const totalInc = inc1USD + inc2USD;
  const netYield = totalVal > 0 ? (totalNet * 12 / totalVal) * 100 : 0;
  const irr = calcIRR(totalVal, totalNet * 12, totalVal, 20);

  const projection = Array.from({ length: 20 }, (_, i) => ({
    year: i + 1,
    cum: Math.round(-totalVal + totalNet * 12 * (i + 1)),
    recovered: -totalVal + totalNet * 12 * (i + 1) >= 0,
  }));
  const pbYear = projection.find(r => r.recovered)?.year;
  const maxAbs = Math.max(...projection.map(r => Math.abs(r.cum)));

  // Actividad reciente
  const recentTxs = transactions.slice(0, 5);
  const recentBookings = bookings.filter(b => b.status === "confirmed").slice(0, 3);

  // Mini chart de últimos 6 meses
  const last6 = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const inc = transactions.filter(t => t.type === "income" && t.date?.startsWith(monthStr)).reduce((s, t) => s + t.amountUSD, 0);
    const exp = transactions.filter(t => t.type === "expense" && t.date?.startsWith(monthStr)).reduce((s, t) => s + t.amountUSD, 0);
    return { month: MONTHS[d.getMonth()], inc: inc || (i === 5 ? inc1USD + inc2USD : 0), exp: exp || (i === 5 ? exp1USD + 20 : 0) };
  });
  const maxBar = Math.max(...last6.map(m => m.inc), 1);

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: "-0.5px" }}>
          Buen {now.getHours() < 12 ? "día" : now.getHours() < 19 ? "tarde" : "noche"} 👋
        </h1>
        <p style={{ color: C.textSec, fontSize: 14, marginTop: 6 }}>
          {now.toLocaleDateString("es-AR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          {" · "}TC ${tc.toLocaleString("es-AR")} ARS/USD
        </p>
      </div>

      {/* KPIs top */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Valor del portfolio", value: fUSD(totalVal), sub: `${properties.length} propiedades`, color: C.text, icon: "🏘️" },
          { label: "Ingreso neto / mes", value: fUSD(totalNet), sub: `bruto: ${fUSD(totalInc)}`, color: C.green, icon: "💰" },
          { label: "Rentabilidad neta", value: fPct(netYield), sub: "anual en USD", color: netYield > 4 ? C.green : C.yellow, icon: "📈" },
          { label: "TIR estimada", value: fPct(irr), sub: "20 años proyección", color: irr > 6 ? C.green : irr > 3 ? C.yellow : C.red, icon: "🎯" },
        ].map(({ label, value, sub, color, icon }) => (
          <div key={label} style={{ ...S.card, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 16, right: 16, fontSize: 24, opacity: 0.15 }}>{icon}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color, letterSpacing: "-0.5px" }}>{value}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Segunda fila */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Cap Rate", value: fPct((cap1 + cap2) / 2), sub: "sobre valor mercado" },
          { label: "Payback portfolio", value: pbYear ? `Año ${pbYear}` : "N/A", sub: "recupero inversión" },
          { label: "Egresos / mes", value: fUSD(exp1USD + 20), sub: "operativos", color: C.red },
          { label: "Ocupación Depto 2", value: `${Math.round(nights / 30 * 100)}%`, sub: `${nights} noches/mes est.` },
        ].map(({ label, value, sub, color }) => (
          <div key={label} style={{ background: C.bgInput, borderRadius: 12, padding: "16px 18px", border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text }}>{value}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Depto 1 */}
        <div style={{ ...S.card, borderLeft: `3px solid ${C.green}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{d1?.name || "Depto 1 · Renta Fija"}</div>
              <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>1 dorm · 2 ambientes grandes</div>
            </div>
            <span style={{ fontSize: 11, background: C.greenBg, color: C.green, padding: "4px 10px", borderRadius: 20, fontWeight: 600, border: `1px solid ${C.greenBorder}` }}>Alquilado</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Ingreso bruto", value: fARS(inc1ARS), sub: fUSD(inc1USD) },
              { label: "Neto / mes", value: fUSD(net1USD), color: C.green },
              { label: "Valor", value: fUSD(val1) },
              { label: "Cap Rate", value: fPct(cap1), color: cap1 > 4 ? C.green : C.yellow },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={{ background: C.bgInput, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: color || C.text }}>{value}</div>
                {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{sub}</div>}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", background: C.greenBg, borderRadius: 10, padding: "10px 14px", border: `1px solid ${C.greenBorder}` }}>
            <span style={{ fontSize: 13, color: C.green }}>Payback estimado</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{pb1 ? pb1.toFixed(1) + " años" : "N/A"}</span>
          </div>
        </div>

        {/* Depto 2 */}
        <div style={{ ...S.card, borderLeft: `3px solid ${C.yellow}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{d2?.name || "Depto 2 · Renta Temporal"}</div>
              <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>1 dorm · 2 ambientes chicos</div>
            </div>
            <span style={{ fontSize: 11, background: C.yellowBg, color: C.yellow, padding: "4px 10px", borderRadius: 20, fontWeight: 600, border: `1px solid ${C.yellowBorder}` }}>Por día</span>
          </div>
          {/* Slider */}
          <div style={{ background: C.bgInput, borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: C.textSec }}>Noches ocupadas / mes</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.yellow }}>{nights} noches · {Math.round(nights/30*100)}%</span>
            </div>
            <input type="range" min={0} max={30} value={nights} onChange={e => setNights(Number(e.target.value))}
              style={{ width: "100%", accentColor: C.yellow, cursor: "pointer" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Ingreso estimado", value: fARS(inc2ARS), sub: fUSD(inc2USD) },
              { label: "Neto / mes", value: fUSD(net2USD), color: C.green },
              { label: "Valor", value: fUSD(val2) },
              { label: "Cap Rate", value: fPct(cap2), color: cap2 > 4 ? C.green : C.yellow },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={{ background: C.bgInput, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: color || C.text }}>{value}</div>
                {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{sub}</div>}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", background: C.yellowBg, borderRadius: 10, padding: "10px 14px", border: `1px solid ${C.yellowBorder}` }}>
            <span style={{ fontSize: 13, color: C.yellow }}>Payback estimado</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.yellow }}>{pb2 ? pb2.toFixed(1) + " años" : "N/A"}</span>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Gráfico barras */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Ingresos últimos 6 meses</div>
              <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>En USD al tipo de cambio actual</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 140 }}>
            {last6.map((m, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ width: "100%", height: 120, display: "flex", alignItems: "flex-end", gap: 3 }}>
                  <div style={{ flex: 1, height: `${(m.inc / maxBar) * 100}%`, background: `linear-gradient(to top, ${C.green}aa, ${C.green}44)`, borderRadius: "4px 4px 0 0", minHeight: 4, transition: "height 0.5s" }} title={fUSD(m.inc)} />
                  <div style={{ flex: 1, height: `${(m.exp / maxBar) * 60}%`, background: `linear-gradient(to top, ${C.red}88, ${C.red}33)`, borderRadius: "4px 4px 0 0", minHeight: 2, transition: "height 0.5s" }} title={fUSD(m.exp)} />
                </div>
                <span style={{ fontSize: 11, color: C.textMuted }}>{m.month}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: C.green }} /><span style={{ fontSize: 11, color: C.textSec }}>Ingresos</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: C.red }} /><span style={{ fontSize: 11, color: C.textSec }}>Egresos</span></div>
          </div>
        </div>

        {/* Proyección recupero */}
        <div style={S.card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Recupero de inversión</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>Proyección 20 años</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 100, marginBottom: 12 }}>
            {projection.map((r, i) => {
              const pct = maxAbs > 0 ? Math.abs(r.cum) / maxAbs * 100 : 0;
              const isPayback = r.recovered && !projection[i-1]?.recovered;
              return (
                <div key={r.year} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
                  <div title={`Año ${r.year}: ${fUSD(r.cum)}`}
                    style={{ width: "100%", height: `${Math.max(pct, 4)}%`, borderRadius: "3px 3px 0 0",
                      background: isPayback ? C.green : r.recovered ? `${C.green}66` : `${C.red}55`,
                      transition: "height 0.4s",
                    }} />
                </div>
              );
            })}
          </div>
          {pbYear ? (
            <div style={{ background: C.greenBg, borderRadius: 10, padding: "12px 14px", border: `1px solid ${C.greenBorder}` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>✓ Recupero en año {pbYear}</div>
              <div style={{ fontSize: 11, color: C.textSec, marginTop: 3 }}>TIR {fPct(irr)} · Neto {fUSD(totalNet)}/mes</div>
            </div>
          ) : (
            <div style={{ background: C.redBg, borderRadius: 10, padding: "10px 14px", border: `1px solid ${C.redBorder}` }}>
              <div style={{ fontSize: 12, color: C.red }}>No se recupera en 20 años con estos datos</div>
            </div>
          )}
        </div>
      </div>

      {/* Actividad reciente */}
      {recentTxs.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Actividad reciente</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {recentTxs.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                  background: t.type === "income" ? C.greenBg : C.redBg }}>
                  {t.type === "income" ? "↑" : "↓"}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{t.description}</div>
                  <div style={{ fontSize: 12, color: C.textSec }}>{t.date}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.type === "income" ? C.green : C.red }}>
                    {t.type === "income" ? "+" : "−"}{fUSD(t.amountUSD)}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{fARS(t.amountARS)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PROPIEDADES
// ════════════════════════════════════════════════════════════════════════════
function Properties({ properties, transactions, tc, reload, db }) {
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", type: "fixed_rental", address: "", bedrooms: 1, sqm: 0, estimatedValueUSD: 0, purchasePriceUSD: 0, status: "rented", description: "" });

  function setF(f, v) { setForm(p => ({ ...p, [f]: v })); }

  async function save() {
    if (!form.name) { setError("El nombre es obligatorio."); return; }
    setSaving(true); setError("");
    try {
      await addDoc(collection(db, "re_properties"), { ...form, photos: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      await reload();
      setShowForm(false);
      setForm({ name: "", type: "fixed_rental", address: "", bedrooms: 1, sqm: 0, estimatedValueUSD: 0, purchasePriceUSD: 0, status: "rented", description: "" });
    } catch { setError("Error al guardar."); }
    finally { setSaving(false); }
  }

  async function remove(id) {
    if (!confirm("¿Eliminar esta propiedad?")) return;
    await deleteDoc(doc(db, "re_properties", id));
    await reload();
  }

  const statusMap = {
    rented:      { label: "Alquilado",     color: C.green,  bg: C.greenBg,  border: C.greenBorder },
    available:   { label: "Disponible",    color: C.blue,   bg: C.blueBg,   border: "rgba(77,159,255,0.2)" },
    maintenance: { label: "Mantenimiento", color: C.yellow, bg: C.yellowBg, border: C.yellowBorder },
  };

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Propiedades</h1>
          <p style={{ color: C.textSec, fontSize: 14, marginTop: 4 }}>{properties.length} inmuebles en el portfolio</p>
        </div>
        <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva propiedad</button>
      </div>

      {properties.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏠</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No hay propiedades</div>
          <div style={{ color: C.textSec, marginBottom: 24 }}>Agregá tu primer inmueble para empezar</div>
          <button onClick={() => setShowForm(true)} style={S.btn}>+ Agregar propiedad</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {properties.map(p => {
            const st = statusMap[p.status] || { label: p.status, color: C.textSec, bg: C.bgInput, border: C.border };
            const propTxs = transactions.filter(t => t.propertyId === p.id);
            const monthInc = propTxs.filter(t => t.type === "income").reduce((s,t) => s + t.amountUSD, 0) / 3;
            const monthExp = propTxs.filter(t => t.type === "expense").reduce((s,t) => s + t.amountUSD, 0) / 3;
            const cap = p.estimatedValueUSD > 0 ? ((monthInc - monthExp) * 12 / p.estimatedValueUSD) * 100 : 0;

            return (
              <div key={p.id} style={{ ...S.card, borderLeft: `3px solid ${st.color}`, transition: "all 0.2s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 3 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: C.textSec }}>{p.address || "Sin dirección"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 11, background: st.bg, color: st.color, padding: "4px 10px", borderRadius: 20, fontWeight: 600, border: `1px solid ${st.border}` }}>{st.label}</span>
                    <button onClick={() => remove(p.id)} style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, color: C.red, borderRadius: 8, width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>×</button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                  {[
                    { label: "Tipo", value: p.type === "fixed_rental" ? "Renta fija" : "Temporal" },
                    { label: "Valor", value: fUSD(p.estimatedValueUSD) },
                    { label: "Dormitorios", value: p.bedrooms || "—" },
                    { label: "Superficie", value: p.sqm ? `${p.sqm}m²` : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: C.bgInput, borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>

                {monthInc > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[
                      { label: "Ingreso neto/mes", value: fUSD(monthInc - monthExp), color: C.green },
                      { label: "Cap Rate", value: fPct(cap), color: cap > 4 ? C.green : C.yellow },
                      { label: "Plusvalía", value: fUSD(p.estimatedValueUSD - p.purchasePriceUSD), color: p.estimatedValueUSD > p.purchasePriceUSD ? C.green : C.red },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ background: C.bgInput, borderRadius: 8, padding: "8px 10px" }}>
                        <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}

                {p.description && (
                  <div style={{ marginTop: 12, fontSize: 12, color: C.textSec, padding: "8px 0", borderTop: `1px solid ${C.border}` }}>{p.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Nueva propiedad</div>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", color: C.textSec, fontSize: 22, cursor: "pointer" }}>×</button>
            </div>
            {error && <div style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.red, marginBottom: 16 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { label: "Nombre *", field: "name", placeholder: "Depto 1 · Palermo" },
                { label: "Dirección", field: "address", placeholder: "Av. Santa Fe 1234, CABA" },
              ].map(({ label, field, placeholder }) => (
                <div key={field}>
                  <label style={S.label}>{label}</label>
                  <input style={S.input} placeholder={placeholder} value={form[field]} onChange={e => setF(field, e.target.value)} />
                </div>
              ))}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Tipo de renta</label>
                  <select style={{ ...S.input }} value={form.type} onChange={e => setF("type", e.target.value)}>
                    <option value="fixed_rental">Renta fija</option>
                    <option value="short_term">Renta temporal</option>
                  </select>
                </div>
                <div>
                  <label style={S.label}>Estado</label>
                  <select style={{ ...S.input }} value={form.status} onChange={e => setF("status", e.target.value)}>
                    <option value="rented">Alquilado</option>
                    <option value="available">Disponible</option>
                    <option value="maintenance">Mantenimiento</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Valor estimado (USD)</label>
                  <input type="number" style={S.input} placeholder="67000" value={form.estimatedValueUSD || ""} onChange={e => setF("estimatedValueUSD", Number(e.target.value))} />
                </div>
                <div>
                  <label style={S.label}>Precio de compra (USD)</label>
                  <input type="number" style={S.input} placeholder="67000" value={form.purchasePriceUSD || ""} onChange={e => setF("purchasePriceUSD", Number(e.target.value))} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Dormitorios</label>
                  <input type="number" style={S.input} min={0} value={form.bedrooms} onChange={e => setF("bedrooms", Number(e.target.value))} />
                </div>
                <div>
                  <label style={S.label}>Superficie (m²)</label>
                  <input type="number" style={S.input} min={0} value={form.sqm || ""} onChange={e => setF("sqm", Number(e.target.value))} />
                </div>
              </div>
              <div>
                <label style={S.label}>Descripción</label>
                <textarea style={{ ...S.input, minHeight: 70, resize: "none" }} value={form.description} onChange={e => setF("description", e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1, justifyContent: "center" }}>{saving ? "Guardando..." : "Guardar propiedad"}</button>
                <button onClick={() => setShowForm(false)} style={S.btnSec}>Cancelar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RESERVAS
// ════════════════════════════════════════════════════════════════════════════
function Bookings({ properties, bookings, tc, reload, db }) {
  const [showForm, setShowForm] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const shortProps = properties.filter(p => p.type === "short_term");
  const [propId, setPropId] = useState(shortProps[0]?.id || "");
  const [form, setForm] = useState({ guestName: "", guestEmail: "", guestPhone: "", checkIn: "", checkOut: "", source: "direct", status: "confirmed", notes: "" });

  useEffect(() => { if (shortProps.length > 0 && !propId) setPropId(shortProps[0].id); }, [shortProps]);

  function setF(f, v) { setForm(p => ({ ...p, [f]: v })); }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const todayD = new Date();

  const occupiedMap = useMemo(() => {
    const m = {};
    bookings.filter(b => b.propertyId === propId && b.status !== "cancelled").forEach(b => {
      const cur = new Date(b.checkIn), end = new Date(b.checkOut);
      while (cur < end) { m[cur.toISOString().split("T")[0]] = b; cur.setDate(cur.getDate() + 1); }
    });
    return m;
  }, [bookings, propId]);

  const nights = form.checkIn && form.checkOut
    ? Math.max(0, Math.round((new Date(form.checkOut) - new Date(form.checkIn)) / 86400000)) : 0;
  const pricing = nights > 0 ? calcPricing(nights, 70000, 15000) : null;

  async function save() {
    if (!form.guestName || !form.checkIn || !form.checkOut || nights <= 0) { setError("Completá todos los campos."); return; }
    setSaving(true); setError("");
    try {
      await addDoc(collection(db, "re_bookings"), {
        ...form, propertyId: propId, nights,
        basePricePerNight: 70000, cleaningFee: 15000,
        totalARS: pricing?.total || 0,
        totalUSD: pricing ? arsToUsd(pricing.total, tc) : 0,
        exchangeRateUsed: tc,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      await reload();
      setShowForm(false);
      setForm({ guestName: "", guestEmail: "", guestPhone: "", checkIn: "", checkOut: "", source: "direct", status: "confirmed", notes: "" });
    } catch { setError("Error al guardar."); }
    finally { setSaving(false); }
  }

  const monthIncome = bookings
    .filter(b => b.propertyId === propId && b.status !== "cancelled" && new Date(b.checkIn).getMonth() === month)
    .reduce((s, b) => s + (b.totalARS || 0), 0);
  const occupiedNights = Object.values(occupiedMap).filter(b => b.status !== "blocked" && new Date(b.checkIn).getMonth() === month).length;

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Reservas</h1>
          <p style={{ color: C.textSec, fontSize: 14, marginTop: 4 }}>Calendario de ocupación · Renta temporal</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {shortProps.length > 1 && (
            <select style={{ ...S.input, width: 200 }} value={propId} onChange={e => setPropId(e.target.value)}>
              {shortProps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva reserva</button>
        </div>
      </div>

      {shortProps.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📅</div>
          <div style={{ fontSize: 16, color: C.textSec }}>No tenés propiedades de renta temporal</div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
            {[
              { label: "Ingresos del mes", value: fARS(monthIncome), sub: fUSD(monthIncome / tc), color: C.green },
              { label: "Noches ocupadas", value: String(occupiedNights), sub: `${Math.round(occupiedNights / daysInMonth * 100)}% del mes` },
              { label: "Reservas activas", value: String(bookings.filter(b => b.status === "confirmed").length), sub: "confirmadas" },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={{ background: C.bgInput, borderRadius: 12, padding: "16px 18px", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text }}>{value}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{sub}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {/* Calendario */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <button onClick={() => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m => m-1); }}
                  style={{ ...S.btnSec, padding: "8px 14px" }}>‹</button>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{MONTHS_FULL[month]} {year}</div>
                </div>
                <button onClick={() => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m => m+1); }}
                  style={{ ...S.btnSec, padding: "8px 14px" }}>›</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 6 }}>
                {DAYS.map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, color: C.textMuted, padding: "4px 0", fontWeight: 600 }}>{d}</div>)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
                {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const d = i + 1;
                  const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
                  const bk = occupiedMap[dateStr];
                  const isToday = todayD.getFullYear() === year && todayD.getMonth() === month && todayD.getDate() === d;
                  return (
                    <div key={d} title={bk ? bk.guestName : ""} style={{
                      aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: 8, fontSize: 12, fontWeight: bk ? 700 : 400,
                      background: bk?.status === "blocked" ? C.redBg : bk ? C.yellowBg : "transparent",
                      color: bk?.status === "blocked" ? C.red : bk ? C.yellow : C.textSec,
                      outline: isToday ? `2px solid ${C.green}` : "none",
                      outlineOffset: 1, cursor: bk ? "pointer" : "default",
                    }}>{d}</div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                {[{ bg: C.yellowBg, color: C.yellow, label: "Ocupado" }, { bg: C.redBg, color: C.red, label: "Bloqueado" }].map(({ bg, color, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: bg, border: `1px solid ${color}` }} />
                    <span style={{ fontSize: 11, color: C.textSec }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Lista reservas */}
            <div style={S.card}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Próximas reservas</div>
              {bookings.filter(b => b.status === "confirmed").length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: C.textMuted }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
                  <div>No hay reservas confirmadas</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {bookings.filter(b => b.status === "confirmed").sort((a,b) => a.checkIn.localeCompare(b.checkIn)).map(b => (
                    <div key={b.id} style={{ background: C.bgInput, borderRadius: 12, padding: "12px 14px", border: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{b.guestName}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{fARS(b.totalARS)}</div>
                      </div>
                      <div style={{ fontSize: 12, color: C.textSec }}>{b.checkIn} → {b.checkOut} · {b.nights} noches</div>
                      {b.source && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, textTransform: "capitalize" }}>{b.source}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Nueva reserva</div>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", color: C.textSec, fontSize: 22, cursor: "pointer" }}>×</button>
            </div>
            {error && <div style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.red, marginBottom: 16 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><label style={S.label}>Huésped *</label><input style={S.input} value={form.guestName} onChange={e => setF("guestName", e.target.value)} placeholder="Juan Pérez" /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div><label style={S.label}>Email</label><input type="email" style={S.input} value={form.guestEmail} onChange={e => setF("guestEmail", e.target.value)} /></div>
                <div><label style={S.label}>Teléfono</label><input style={S.input} value={form.guestPhone} onChange={e => setF("guestPhone", e.target.value)} /></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div><label style={S.label}>Check-in *</label><input type="date" style={S.input} value={form.checkIn} onChange={e => setF("checkIn", e.target.value)} /></div>
                <div><label style={S.label}>Check-out *</label><input type="date" style={S.input} value={form.checkOut} onChange={e => setF("checkOut", e.target.value)} /></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Fuente</label>
                  <select style={S.input} value={form.source} onChange={e => setF("source", e.target.value)}>
                    <option value="direct">Directa</option>
                    <option value="airbnb">Airbnb</option>
                    <option value="booking">Booking</option>
                    <option value="other">Otra</option>
                  </select>
                </div>
                <div>
                  <label style={S.label}>Estado</label>
                  <select style={S.input} value={form.status} onChange={e => setF("status", e.target.value)}>
                    <option value="confirmed">Confirmada</option>
                    <option value="blocked">Bloqueado</option>
                  </select>
                </div>
              </div>
              {pricing && (
                <div style={{ background: C.greenBg, border: `1px solid ${C.greenBorder}`, borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 4 }}>{nights} noches · {pricing.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.green }}>{fARS(pricing.total)}</div>
                  <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>{fARS(pricing.perNight)}/noche + $15.000 limpieza · {fUSD(arsToUsd(pricing.total, tc))}</div>
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1, justifyContent: "center" }}>{saving ? "Guardando..." : "Guardar reserva"}</button>
                <button onClick={() => setShowForm(false)} style={S.btnSec}>Cancelar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSACCIONES
// ════════════════════════════════════════════════════════════════════════════
function Transactions({ properties, transactions, tc, reload, db }) {
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [type, setType] = useState("income");
  const [amountARS, setAmountARS] = useState("");
  const [form, setForm] = useState({ propertyId: "", category: "rent", date: todayStr(), description: "" });

  function setF(f, v) { setForm(p => ({ ...p, [f]: v })); }

  const CATS = {
    income: [["rent","Alquiler"],["booking","Reserva"]],
    expense: [["expensas","Expensas"],["expensas_extraordinarias","Expensas ext."],["impuesto","Impuesto"],["reparacion","Reparación"],["comision","Comisión"],["limpieza","Limpieza"],["seguro","Seguro"],["otros","Otros"]],
  };
  const catLabel = { rent:"Alquiler",booking:"Reserva",expensas:"Expensas",expensas_extraordinarias:"Expensas ext.",impuesto:"Impuesto",reparacion:"Reparación",comision:"Comisión",limpieza:"Limpieza",seguro:"Seguro",otros:"Otros" };

  const totals = {
    income: transactions.filter(t => t.type === "income").reduce((s,t) => s + t.amountUSD, 0),
    expense: transactions.filter(t => t.type === "expense").reduce((s,t) => s + t.amountUSD, 0),
  };

  async function save() {
    if (!form.propertyId || !amountARS || !form.description) { setError("Completá todos los campos."); return; }
    setSaving(true); setError("");
    try {
      const ars = Number(amountARS);
      await addDoc(collection(db, "re_transactions"), {
        ...form, type, amountARS: ars, amountUSD: arsToUsd(ars, tc), exchangeRateUsed: tc, createdAt: serverTimestamp(),
      });
      await reload();
      setShowForm(false); setAmountARS("");
      setForm({ propertyId: "", category: "rent", date: todayStr(), description: "" });
    } catch { setError("Error al guardar."); }
    finally { setSaving(false); }
  }

  const filtered = filter === "all" ? transactions : transactions.filter(t => t.type === filter);
  const propName = id => properties.find(p => p.id === id)?.name || "—";

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Transacciones</h1>
          <p style={{ color: C.textSec, fontSize: 14, marginTop: 4 }}>{transactions.length} registros · ingresos y egresos</p>
        </div>
        <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva transacción</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Ingresos totales", value: fUSD(totals.income), color: C.green, icon: "↑" },
          { label: "Egresos totales", value: fUSD(totals.expense), color: C.red, icon: "↓" },
          { label: "Resultado neto", value: fUSD(totals.income - totals.expense), color: totals.income > totals.expense ? C.green : C.red, icon: "=" },
        ].map(({ label, value, color, icon }) => (
          <div key={label} style={{ ...S.card, display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color }}>
              {icon}
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["all","income","expense"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "8px 16px", borderRadius: 8, border: `1px solid ${filter === f ? C.green : C.border}`,
            background: filter === f ? C.greenBg : "transparent",
            color: filter === f ? C.green : C.textSec,
            fontSize: 13, fontWeight: 500, cursor: "pointer",
          }}>
            {{ all: "Todos", income: "Ingresos", expense: "Egresos" }[f]}
          </button>
        ))}
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: C.textMuted }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>💳</div>
            <div>No hay transacciones</div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Fecha","Propiedad","Descripción","Categoría","ARS","USD"].map(h => (
                  <th key={h} style={{ padding: "14px 18px", textAlign: "left", fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "12px 18px", color: C.textSec }}>{t.date}</td>
                  <td style={{ padding: "12px 18px", color: C.textSec, fontSize: 12 }}>{propName(t.propertyId)}</td>
                  <td style={{ padding: "12px 18px", fontWeight: 500 }}>{t.description}</td>
                  <td style={{ padding: "12px 18px" }}>
                    <span style={{ background: C.bgInput, color: C.textSec, padding: "3px 8px", borderRadius: 6, fontSize: 11, border: `1px solid ${C.border}` }}>
                      {catLabel[t.category] || t.category}
                    </span>
                  </td>
                  <td style={{ padding: "12px 18px", color: C.textSec }}>{fARS(t.amountARS)}</td>
                  <td style={{ padding: "12px 18px", fontWeight: 700, color: t.type === "income" ? C.green : C.red }}>
                    {t.type === "income" ? "+" : "−"}{fUSD(t.amountUSD)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Nueva transacción</div>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", color: C.textSec, fontSize: 22, cursor: "pointer" }}>×</button>
            </div>
            {error && <div style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.red, marginBottom: 16 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {["income","expense"].map(t => (
                  <button key={t} onClick={() => { setType(t); setF("category", t === "income" ? "rent" : "expensas"); }}
                    style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: `1px solid ${type === t ? (t === "income" ? C.green : C.red) : C.border}`,
                      background: type === t ? (t === "income" ? C.greenBg : C.redBg) : "transparent",
                      color: type === t ? (t === "income" ? C.green : C.red) : C.textSec,
                      fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                    {t === "income" ? "⬆ Ingreso" : "⬇ Egreso"}
                  </button>
                ))}
              </div>
              <div>
                <label style={S.label}>Propiedad *</label>
                <select style={S.input} value={form.propertyId} onChange={e => setF("propertyId", e.target.value)}>
                  <option value="">Seleccioná una propiedad</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Categoría</label>
                <select style={S.input} value={form.category} onChange={e => setF("category", e.target.value)}>
                  {CATS[type].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div><label style={S.label}>Descripción *</label><input style={S.input} placeholder="Alquiler mayo 2025" value={form.description} onChange={e => setF("description", e.target.value)} /></div>
              <div><label style={S.label}>Fecha</label><input type="date" style={S.input} value={form.date} onChange={e => setF("date", e.target.value)} /></div>
              <div>
                <label style={S.label}>Monto en ARS *</label>
                <input type="number" style={S.input} placeholder="476670" value={amountARS} onChange={e => setAmountARS(e.target.value)} />
                {amountARS > 0 && (
                  <div style={{ fontSize: 12, color: C.textSec, marginTop: 6 }}>
                    ≈ <span style={{ color: C.green, fontWeight: 600 }}>{fUSD(arsToUsd(Number(amountARS), tc))}</span> al tipo ${tc.toLocaleString("es-AR")}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1, justifyContent: "center" }}>{saving ? "Guardando..." : "Guardar"}</button>
                <button onClick={() => setShowForm(false)} style={S.btnSec}>Cancelar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ANÁLISIS
// ════════════════════════════════════════════════════════════════════════════
function Analytics({ properties, transactions, tc }) {
  const [propId, setPropId] = useState("all");
  const [years, setYears] = useState(20);

  const props = propId === "all" ? properties : properties.filter(p => p.id === propId);
  const txs = propId === "all" ? transactions : transactions.filter(t => t.propertyId === propId);

  const totalVal = props.reduce((s, p) => s + p.estimatedValueUSD, 0);
  const grossInc = txs.filter(t => t.type === "income").reduce((s,t) => s + t.amountUSD, 0) / Math.max(1, 3);
  const expenses = txs.filter(t => t.type === "expense").reduce((s,t) => s + t.amountUSD, 0) / Math.max(1, 3);
  const netInc = grossInc - expenses;
  const annualNet = netInc * 12;
  const grossY = totalVal > 0 ? (grossInc * 12 / totalVal) * 100 : 0;
  const netY = totalVal > 0 ? (annualNet / totalVal) * 100 : 0;
  const irr = calcIRR(totalVal, annualNet, totalVal, years);

  const projection = Array.from({ length: years }, (_, i) => {
    const year = i + 1;
    const cum = -totalVal + annualNet * year;
    return { year, cum: Math.round(cum), net: Math.round(annualNet), inc: Math.round(grossInc * 12), exp: Math.round(expenses * 12), recovered: cum >= 0 };
  });
  const pbYear = projection.find(r => r.recovered)?.year;
  const maxAbs = Math.max(...projection.map(r => Math.abs(r.cum)), 1);

  // Pricing dinámico
  const pricingExamples = [1, 2, 3, 5, 7, 14].map(n => ({ nights: n, ...calcPricing(n, 70000, 15000) }));

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Análisis financiero</h1>
          <p style={{ color: C.textSec, fontSize: 14, marginTop: 4 }}>TIR · Payback · Cap Rate · Flujo de caja</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <select style={{ ...S.input, width: 200 }} value={propId} onChange={e => setPropId(e.target.value)}>
            <option value="all">Todo el portfolio</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 13, color: C.textSec }}>Años:</label>
            <input type="number" min={5} max={40} value={years} onChange={e => setYears(Number(e.target.value))}
              style={{ ...S.input, width: 70, textAlign: "center" }} />
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Cap Rate", value: fPct(netY), color: netY > 4 ? C.green : C.yellow, icon: "%" },
          { label: "TIR", value: fPct(irr), color: irr > 6 ? C.green : irr > 3 ? C.yellow : C.red, icon: "↗" },
          { label: "Rentabilidad neta", value: fPct(netY), color: C.text, icon: "📈" },
          { label: "Payback", value: pbYear ? `Año ${pbYear}` : "N/A", color: pbYear ? C.green : C.red, icon: "⏱" },
        ].map(({ label, value, color, icon }) => (
          <div key={label} style={{ ...S.card, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 14, right: 16, fontSize: 22, opacity: 0.1 }}>{icon}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={S.card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 18 }}>Flujo mensual (USD)</div>
          {[
            { label: "Ingreso bruto / mes", value: fUSD(grossInc), color: C.text },
            { label: "Egresos / mes", value: `− ${fUSD(expenses)}`, color: C.red },
            { label: "Ingreso neto / mes", value: fUSD(netInc), color: C.green },
            { label: "Ingreso neto / año", value: fUSD(annualNet), color: C.green, big: true },
          ].map(({ label, value, color, big }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13, color: C.textSec }}>{label}</span>
              <span style={{ fontSize: big ? 18 : 14, fontWeight: big ? 800 : 600, color }}>{value}</span>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 18 }}>Métricas de rentabilidad</div>
          {[
            { label: "Rentabilidad bruta anual", value: fPct(grossY) },
            { label: "Rentabilidad neta anual", value: fPct(netY) },
            { label: "Cap Rate", value: fPct(netY) },
            { label: "TIR", value: fPct(irr), big: true, color: irr > 6 ? C.green : C.yellow },
          ].map(({ label, value, big, color }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13, color: C.textSec }}>{label}</span>
              <span style={{ fontSize: big ? 18 : 14, fontWeight: big ? 800 : 600, color: color || C.text }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Gráfico proyección */}
      <div style={{ ...S.card, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Proyección flujo de caja · {years} años</div>
            <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>Acumulado neto en USD</div>
          </div>
          {pbYear && <span style={{ background: C.greenBg, color: C.green, border: `1px solid ${C.greenBorder}`, padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 700 }}>Recupero año {pbYear}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 140, marginBottom: 16 }}>
          {projection.map((r, i) => {
            const pct = Math.abs(r.cum) / maxAbs * 100;
            const isPayback = r.recovered && !projection[i-1]?.recovered;
            return (
              <div key={r.year} style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                <div title={`Año ${r.year}: ${fUSD(r.cum)}`} style={{
                  width: "100%", height: `${Math.max(pct, 3)}%`, borderRadius: "4px 4px 0 0",
                  background: isPayback ? `linear-gradient(to top, ${C.green}, ${C.green}88)` : r.recovered ? `${C.green}44` : `${C.red}44`,
                  transition: "height 0.5s",
                }} />
                {(r.year === 1 || r.year % 5 === 0) && <span style={{ fontSize: 9, color: C.textMuted }}>{r.year}</span>}
              </div>
            );
          })}
        </div>
        {pbYear && (
          <div style={{ background: C.greenBg, borderRadius: 12, padding: "12px 16px", border: `1px solid ${C.greenBorder}` }}>
            <span style={{ color: C.green, fontWeight: 600, fontSize: 13 }}>✓ Recupero de inversión en el año {pbYear} · TIR {fPct(irr)} anual · Neto {fUSD(netInc)}/mes</span>
          </div>
        )}
      </div>

      {/* Tabla flujo */}
      <div style={{ ...S.card, padding: 0, overflow: "hidden", marginBottom: 20 }}>
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Tabla de flujo de caja</div>
        </div>
        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ position: "sticky", top: 0, background: C.bgCard }}>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Año","Ingresos","Egresos","Neto","Acumulado"].map(h => (
                  <th key={h} style={{ padding: "12px 18px", textAlign: "left", fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projection.map(r => {
                const isPayback = r.recovered && !projection[r.year-2]?.recovered;
                return (
                  <tr key={r.year} style={{ borderBottom: `1px solid ${C.border}`, background: isPayback ? C.greenBg : "transparent" }}>
                    <td style={{ padding: "10px 18px", color: C.textSec }}>Año {r.year}</td>
                    <td style={{ padding: "10px 18px", color: C.green }}>{fUSD(r.inc)}</td>
                    <td style={{ padding: "10px 18px", color: C.red }}>−{fUSD(r.exp)}</td>
                    <td style={{ padding: "10px 18px", fontWeight: 600 }}>{fUSD(r.net)}</td>
                    <td style={{ padding: "10px 18px", fontWeight: 700, color: r.cum >= 0 ? C.green : C.red }}>
                      {r.cum >= 0 ? "+" : ""}{fUSD(r.cum)}
                      {isPayback && <span style={{ marginLeft: 10, background: C.green, color: "#0a0c12", fontSize: 10, padding: "2px 8px", borderRadius: 20, fontWeight: 700 }}>Recupero</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pricing dinámico */}
      <div style={S.card}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Pricing dinámico · Depto 2</div>
        <div style={{ fontSize: 12, color: C.textSec, marginBottom: 18 }}>Base: $70.000 ARS/noche · Fee limpieza: $15.000 ARS</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10 }}>
          {pricingExamples.map(({ nights, total, perNight, label }) => (
            <div key={nights} style={{
              background: nights === 1 ? C.yellowBg : nights >= 7 ? C.greenBg : C.bgInput,
              border: `1px solid ${nights === 1 ? C.yellowBorder : nights >= 7 ? C.greenBorder : C.border}`,
              borderRadius: 12, padding: "12px 10px", textAlign: "center",
            }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>{nights} {nights === 1 ? "noche" : "noches"}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: nights === 1 ? C.yellow : nights >= 7 ? C.green : C.text }}>{fARS(total)}</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{fARS(perNight)}/n</div>
              {nights !== 2 && nights !== 3 && nights !== 5 && (
                <div style={{ fontSize: 9, color: nights === 1 ? C.yellow : C.green, marginTop: 4, fontWeight: 600 }}>
                  {nights === 1 ? "+20%" : "-10%"}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
