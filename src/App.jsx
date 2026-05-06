import { useState, useEffect, useMemo } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp
} from "firebase/firestore";

// ── Firebase ────────────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
const TC_DEFAULT = 1420;
const fARS = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const fUSD = (n) => "u$s " + Math.round(n).toLocaleString("es-AR");
const fPct = (n) => n.toFixed(1) + "%";
const arsToUsd = (ars, tc) => (tc > 0 ? Math.round((ars / tc) * 100) / 100 : 0);
const today = () => new Date().toISOString().split("T")[0];

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
  let rate = base;
  let label = "Tarifa estándar";
  if (nights === 1) { rate = base * 1.2; label = "+20% tarifa 1 noche"; }
  else if (nights >= 7) { rate = base * 0.9; label = "-10% descuento semanal"; }
  const sub = Math.round(rate * nights);
  return { total: sub + clean, perNight: Math.round(rate), label };
}

// ── Colores / estilos base ───────────────────────────────────────────────────
const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 22 },
  metric: { background: "#f8fafc", borderRadius: 12, padding: "14px 16px" },
  btn: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 500, cursor: "pointer" },
  btnSec: { background: "#fff", color: "#555", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 16px", fontSize: 14, cursor: "pointer" },
  input: { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 14, boxSizing: "border-box" },
  label: { fontSize: 12, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 },
  badge: (bg, color) => ({ fontSize: 11, background: bg, color, padding: "3px 10px", borderRadius: 20, fontWeight: 500 }),
  modal: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modalBox: { background: "#fff", borderRadius: 20, padding: 28, width: "100%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto" },
};

const NAV = [
  { id: "dashboard",     label: "Dashboard" },
  { id: "properties",   label: "Propiedades" },
  { id: "bookings",     label: "Reservas" },
  { id: "transactions", label: "Transacciones" },
  { id: "analytics",    label: "Análisis" },
];

// ════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [page, setPage]               = useState("dashboard");
  const [properties, setProperties]   = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [bookings, setBookings]       = useState([]);
  const [tc, setTc]                   = useState(TC_DEFAULT);
  const [loadingData, setLoadingData] = useState(true);

  // ── Carga inicial ──────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoadingData(true);
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
      finally { setLoadingData(false); }
    }
    load();
    // Tipo de cambio
    fetch("/api/exchange-rate").then(r => r.json()).then(d => { if (d.mep) setTc(d.mep); }).catch(() => {});
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
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", background: "#f8fafc" }}>
      {/* Sidebar */}
      <aside style={{ width: 200, background: "#fff", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", padding: "20px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 32, paddingLeft: 8 }}>
          <div style={{ width: 28, height: 28, background: "#16a34a", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, fontWeight: 700 }}>R</div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Rent<span style={{ color: "#16a34a" }}>Ar</span></span>
        </div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)}
            style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, border: "none", background: page === n.id ? "#f0fdf4" : "transparent", color: page === n.id ? "#15803d" : "#555", fontWeight: page === n.id ? 600 : 400, fontSize: 14, cursor: "pointer", marginBottom: 2 }}>
            {n.label}
          </button>
        ))}
        {/* TC */}
        <div style={{ marginTop: "auto", padding: "12px", background: "#f8fafc", borderRadius: 12 }}>
          <p style={{ fontSize: 10, color: "#aaa", margin: "0 0 4px" }}>Dólar MEP</p>
          <input type="number" value={tc} onChange={e => setTc(Number(e.target.value))}
            style={{ width: "100%", fontSize: 15, fontWeight: 600, border: "none", background: "transparent", color: "#111", outline: "none" }} />
          <p style={{ fontSize: 10, color: "#bbb", margin: "2px 0 0" }}>ARS por USD</p>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, overflowY: "auto", padding: 32 }}>
        {loadingData ? (
          <div style={{ textAlign: "center", paddingTop: 80, color: "#aaa" }}>Cargando datos...</div>
        ) : page === "dashboard"     ? <Dashboard {...shared} />
          : page === "properties"   ? <Properties {...shared} />
          : page === "bookings"     ? <Bookings {...shared} />
          : page === "transactions" ? <Transactions {...shared} />
          : page === "analytics"    ? <Analytics {...shared} />
          : null}
      </main>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function Dashboard({ properties, transactions, bookings, tc }) {
  const [nights, setNights] = useState(12);

  const d1 = properties.find(p => p.type === "fixed_rental");
  const d2 = properties.find(p => p.type === "short_term");

  const inc1ARS = d1
    ? transactions.filter(t => t.propertyId === d1.id && t.type === "income").reduce((s, t) => s + t.amountARS, 0) / 3
    : 476670;
  const exp1USD = d1
    ? transactions.filter(t => t.propertyId === d1.id && t.type === "expense").reduce((s, t) => s + t.amountUSD, 0) / 3
    : 40;

  const inc1USD   = arsToUsd(inc1ARS, tc);
  const net1USD   = inc1USD - exp1USD;
  const val1      = d1?.estimatedValueUSD || 67000;
  const cap1      = val1 > 0 ? (net1USD * 12 / val1) * 100 : 0;
  const pb1       = net1USD > 0 ? (val1 / (net1USD * 12)).toFixed(1) : "—";

  const inc2ARS   = 70000 * nights;
  const inc2USD   = arsToUsd(inc2ARS, tc);
  const net2USD   = inc2USD - 20;
  const val2      = d2?.estimatedValueUSD || 57000;
  const cap2      = val2 > 0 ? (net2USD * 12 / val2) * 100 : 0;
  const pb2       = net2USD > 0 ? (val2 / (net2USD * 12)).toFixed(1) : "—";

  const totalVal  = val1 + val2;
  const totalNet  = net1USD + net2USD;
  const totalInc  = inc1USD + inc2USD;
  const netYield  = totalVal > 0 ? (totalNet * 12 / totalVal) * 100 : 0;
  const irr       = calcIRR(totalVal, totalNet * 12, totalVal, 20);

  const projection = Array.from({ length: 20 }, (_, i) => {
    const year = i + 1;
    const cum = -totalVal + (totalNet * 12 * year);
    return { year, cum: Math.round(cum), recovered: cum >= 0 };
  });
  const pbYear = projection.find(r => r.recovered)?.year;
  const maxAbs = Math.max(...projection.map(r => Math.abs(r.cum)));

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Dashboard</h1>
        <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{properties.length} propiedades · TC ${tc.toLocaleString("es-AR")}</p>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Valor del portfolio", value: fUSD(totalVal), color: "#111" },
          { label: "Ingreso neto / mes",  value: fUSD(totalNet), color: "#16a34a" },
          { label: "Rentabilidad neta",   value: fPct(netYield), color: netYield > 4 ? "#16a34a" : "#ca8a04" },
          { label: "TIR estimada",        value: fPct(irr),      color: irr > 6 ? "#16a34a" : irr > 3 ? "#ca8a04" : "#dc2626" },
        ].map(({ label, value, color }) => (
          <div key={label} style={S.card}>
            <p style={{ fontSize: 11, color: "#888", margin: "0 0 8px" }}>{label}</p>
            <p style={{ fontSize: 22, fontWeight: 700, color, margin: 0 }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Deptos */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Depto 1 */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{d1?.name || "Depto 1 · Renta Fija"}</p>
              <p style={{ fontSize: 11, color: "#888", margin: 0 }}>1 dorm · 2 ambientes grandes</p>
            </div>
            <span style={S.badge("#dcfce7","#15803d")}>Alquilado</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Ingreso bruto/mes", value: fARS(inc1ARS), sub: fUSD(inc1USD) },
              { label: "Neto/mes USD",      value: fUSD(net1USD), color: "#16a34a" },
              { label: "Valor propiedad",   value: fUSD(val1) },
              { label: "Cap Rate",          value: fPct(cap1) },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={S.metric}>
                <p style={{ fontSize: 10, color: "#aaa", margin: "0 0 3px" }}>{label}</p>
                <p style={{ fontSize: 14, fontWeight: 700, color: color || "#111", margin: 0 }}>{value}</p>
                {sub && <p style={{ fontSize: 10, color: "#aaa", margin: "2px 0 0" }}>{sub}</p>}
              </div>
            ))}
          </div>
          <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "8px 14px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: "#15803d" }}>Payback</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#15803d" }}>{pb1} años</span>
          </div>
        </div>

        {/* Depto 2 */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{d2?.name || "Depto 2 · Renta Temporal"}</p>
              <p style={{ fontSize: 11, color: "#888", margin: 0 }}>1 dorm · 2 ambientes chicos</p>
            </div>
            <span style={S.badge("#fef9c3","#854d0e")}>Por día</span>
          </div>
          <div style={{ background: "#fffbeb", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "#92400e" }}>Noches / mes</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>{nights} ({Math.round(nights/30*100)}%)</span>
            </div>
            <input type="range" min={0} max={30} value={nights} onChange={e => setNights(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#ca8a04" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Ingreso estimado/mes", value: fARS(inc2ARS), sub: fUSD(inc2USD) },
              { label: "Neto/mes USD",         value: fUSD(net2USD), color: "#16a34a" },
              { label: "Valor propiedad",      value: fUSD(val2) },
              { label: "Cap Rate",             value: fPct(cap2) },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={S.metric}>
                <p style={{ fontSize: 10, color: "#aaa", margin: "0 0 3px" }}>{label}</p>
                <p style={{ fontSize: 14, fontWeight: 700, color: color || "#111", margin: 0 }}>{value}</p>
                {sub && <p style={{ fontSize: 10, color: "#aaa", margin: "2px 0 0" }}>{sub}</p>}
              </div>
            ))}
          </div>
          <div style={{ background: "#fffbeb", borderRadius: 10, padding: "8px 14px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: "#92400e" }}>Payback</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>{pb2} años</span>
          </div>
        </div>
      </div>

      {/* Gráfico proyección */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Proyección de recupero · 20 años</h2>
          <span style={{ fontSize: 12, color: "#888" }}>Acumulado neto USD</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
          {projection.map((r, i) => {
            const pct = maxAbs > 0 ? Math.abs(r.cum) / maxAbs * 100 : 0;
            const isPayback = r.recovered && !projection[i-1]?.recovered;
            return (
              <div key={r.year} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <div style={{ width: "100%", height: 100, display: "flex", alignItems: "flex-end" }}>
                  <div title={`Año ${r.year}: ${fUSD(r.cum)}`}
                    style={{ width: "100%", height: `${pct}%`, background: isPayback ? "#16a34a" : r.recovered ? "#86efac" : "#fca5a5", borderRadius: "3px 3px 0 0" }} />
                </div>
                {(r.year === 1 || r.year % 5 === 0) && <span style={{ fontSize: 9, color: "#aaa" }}>{r.year}</span>}
              </div>
            );
          })}
        </div>
        {pbYear && (
          <div style={{ marginTop: 12, background: "#f0fdf4", borderRadius: 10, padding: "10px 16px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>Recupero en año {pbYear}</span>
            <span style={{ fontSize: 12, color: "#16a34a" }}>TIR {fPct(irr)} · Neto {fUSD(totalNet)}/mes</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PROPIEDADES
// ════════════════════════════════════════════════════════════════════════════
function Properties({ properties, tc, reload, db }) {
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [form, setForm]         = useState({ name: "", type: "fixed_rental", address: "", bedrooms: 1, sqm: 0, estimatedValueUSD: 0, purchasePriceUSD: 0, status: "rented", description: "" });

  function set(f, v) { setForm(p => ({ ...p, [f]: v })); }

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
    rented:      { label: "Alquilado",     color: "#15803d", bg: "#dcfce7" },
    available:   { label: "Disponible",    color: "#1d4ed8", bg: "#dbeafe" },
    maintenance: { label: "Mantenimiento", color: "#92400e", bg: "#fef9c3" },
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Propiedades</h1>
          <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{properties.length} en el portfolio</p>
        </div>
        <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva propiedad</button>
      </div>

      {properties.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 60 }}>
          <p style={{ color: "#aaa", marginBottom: 16 }}>No hay propiedades cargadas</p>
          <button onClick={() => setShowForm(true)} style={S.btn}>+ Agregar propiedad</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {properties.map(p => {
            const st = statusMap[p.status] || { label: p.status, color: "#888", bg: "#f3f4f6" };
            return (
              <div key={p.id} style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                  <div>
                    <p style={{ fontSize: 15, fontWeight: 700, margin: "0 0 3px" }}>{p.name}</p>
                    <p style={{ fontSize: 12, color: "#aaa", margin: 0 }}>{p.address || "Sin dirección"}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={S.badge(st.bg, st.color)}>{st.label}</span>
                    <button onClick={() => remove(p.id)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 16 }}>×</button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  {[
                    { label: "Tipo",  value: p.type === "fixed_rental" ? "Renta fija" : "Renta temporal" },
                    { label: "Valor", value: fUSD(p.estimatedValueUSD) },
                    { label: "Sup.",  value: p.sqm ? `${p.sqm} m²` : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} style={S.metric}>
                      <p style={{ fontSize: 10, color: "#aaa", margin: "0 0 3px" }}>{label}</p>
                      <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Nueva propiedad</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#888" }}>×</button>
            </div>
            {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 14 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { label: "Nombre *", field: "name", placeholder: "Depto 1 · Palermo" },
                { label: "Dirección", field: "address", placeholder: "Av. Santa Fe 1234, CABA" },
              ].map(({ label, field, placeholder }) => (
                <div key={field}>
                  <label style={S.label}>{label}</label>
                  <input style={S.input} placeholder={placeholder} value={form[field]} onChange={e => set(field, e.target.value)} />
                </div>
              ))}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Tipo de renta</label>
                  <select style={S.input} value={form.type} onChange={e => set("type", e.target.value)}>
                    <option value="fixed_rental">Renta fija</option>
                    <option value="short_term">Renta temporal</option>
                  </select>
                </div>
                <div>
                  <label style={S.label}>Estado</label>
                  <select style={S.input} value={form.status} onChange={e => set("status", e.target.value)}>
                    <option value="rented">Alquilado</option>
                    <option value="available">Disponible</option>
                    <option value="maintenance">Mantenimiento</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Valor estimado (USD)</label>
                  <input type="number" style={S.input} placeholder="67000" value={form.estimatedValueUSD || ""} onChange={e => set("estimatedValueUSD", Number(e.target.value))} />
                </div>
                <div>
                  <label style={S.label}>Precio de compra (USD)</label>
                  <input type="number" style={S.input} placeholder="67000" value={form.purchasePriceUSD || ""} onChange={e => set("purchasePriceUSD", Number(e.target.value))} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={S.label}>Dormitorios</label>
                  <input type="number" style={S.input} min={0} value={form.bedrooms} onChange={e => set("bedrooms", Number(e.target.value))} />
                </div>
                <div>
                  <label style={S.label}>Superficie (m²)</label>
                  <input type="number" style={S.input} min={0} value={form.sqm || ""} onChange={e => set("sqm", Number(e.target.value))} />
                </div>
              </div>
              <div>
                <label style={S.label}>Descripción</label>
                <textarea style={{ ...S.input, minHeight: 60, resize: "none" }} value={form.description} onChange={e => set("description", e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1 }}>{saving ? "Guardando..." : "Guardar"}</button>
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
  const [year, setYear]   = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");
  const shortProps = properties.filter(p => p.type === "short_term");
  const [propId, setPropId] = useState(shortProps[0]?.id || "");
  const [form, setForm] = useState({ guestName: "", guestEmail: "", guestPhone: "", checkIn: "", checkOut: "", source: "direct", status: "confirmed", notes: "" });

  function setF(f, v) { setForm(p => ({ ...p, [f]: v })); }

  const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const DAYS   = ["D","L","M","X","J","V","S"];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay    = new Date(year, month, 1).getDay();
  const todayD      = new Date();

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

  const occupiedNights = Object.values(occupiedMap)
    .filter(b => b.status !== "blocked" && new Date(b.checkIn).getMonth() === month).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Reservas</h1>
          <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>Calendario de ocupación</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {shortProps.length > 1 && (
            <select style={{ ...S.input, width: 180 }} value={propId} onChange={e => setPropId(e.target.value)}>
              {shortProps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva reserva</button>
        </div>
      </div>

      {shortProps.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 60, color: "#aaa" }}>
          No tenés propiedades de renta temporal.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
            <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Ingresos del mes</p><p style={{ fontSize: 20, fontWeight: 700, color: "#16a34a", margin: 0 }}>{fARS(monthIncome)}</p></div>
            <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Noches ocupadas</p><p style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{occupiedNights}</p></div>
            <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Reservas activas</p><p style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{bookings.filter(b => b.status === "confirmed").length}</p></div>
          </div>

          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <button onClick={() => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m => m-1); }} style={{ ...S.btnSec, padding: "6px 12px" }}>‹</button>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{MONTHS[month]} {year}</h2>
              <button onClick={() => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m => m+1); }} style={{ ...S.btnSec, padding: "6px 12px" }}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 6 }}>
              {DAYS.map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, color: "#aaa", padding: "4px 0" }}>{d}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
              {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const d = i + 1;
                const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
                const bk = occupiedMap[dateStr];
                const isToday = todayD.getFullYear() === year && todayD.getMonth() === month && todayD.getDate() === d;
                return (
                  <div key={d} title={bk ? bk.guestName : ""}
                    style={{ aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 13, cursor: "default",
                      background: bk?.status === "blocked" ? "#fee2e2" : bk ? "#fef9c3" : "#f8fafc",
                      color: bk?.status === "blocked" ? "#dc2626" : bk ? "#92400e" : "#555",
                      outline: isToday ? "2px solid #16a34a" : "none", outlineOffset: 1,
                    }}>
                    {d}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 12, paddingTop: 12, borderTop: "1px solid #f1f5f9" }}>
              {[{ bg: "#fef9c3", label: "Ocupado" }, { bg: "#fee2e2", label: "Bloqueado" }, { bg: "#f8fafc", label: "Libre" }].map(({ bg, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, background: bg }} />
                  <span style={{ fontSize: 11, color: "#888" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Lista reservas */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 14px" }}>Próximas reservas</h2>
            {bookings.filter(b => b.status === "confirmed").length === 0 ? (
              <p style={{ color: "#aaa", fontSize: 13, textAlign: "center", padding: 20 }}>No hay reservas confirmadas</p>
            ) : (
              bookings.filter(b => b.status === "confirmed").map(b => (
                <div key={b.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 2px" }}>{b.guestName}</p>
                    <p style={{ fontSize: 12, color: "#aaa", margin: 0 }}>{b.checkIn} → {b.checkOut} · {b.nights} noches</p>
                  </div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: "#16a34a", margin: 0 }}>{fARS(b.totalARS)}</p>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Nueva reserva</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 14 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><label style={S.label}>Huésped *</label><input style={S.input} value={form.guestName} onChange={e => setF("guestName", e.target.value)} /></div>
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
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px" }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "#15803d", margin: "0 0 3px" }}>{nights} noches · {pricing.label}</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: "#16a34a", margin: 0 }}>{fARS(pricing.total)} / {fUSD(arsToUsd(pricing.total, tc))}</p>
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1 }}>{saving ? "Guardando..." : "Guardar reserva"}</button>
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
  const [filter, setFilter]     = useState("all");
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [type, setType]         = useState("income");
  const [amountARS, setAmountARS] = useState("");
  const [form, setForm] = useState({ propertyId: "", category: "rent", date: today(), description: "" });

  function setF(f, v) { setForm(p => ({ ...p, [f]: v })); }

  const CATS = {
    income:  [["rent","Alquiler"],["booking","Reserva"]],
    expense: [["expensas","Expensas"],["expensas_extraordinarias","Expensas ext."],["impuesto","Impuesto"],["reparacion","Reparación"],["comision","Comisión"],["limpieza","Limpieza"],["seguro","Seguro"],["otros","Otros"]],
  };

  const totals = {
    income:   transactions.filter(t => t.type === "income").reduce((s,t) => s + t.amountUSD, 0),
    expenses: transactions.filter(t => t.type === "expense").reduce((s,t) => s + t.amountUSD, 0),
  };

  async function save() {
    if (!form.propertyId || !amountARS || !form.description) { setError("Completá todos los campos."); return; }
    setSaving(true); setError("");
    try {
      const ars = Number(amountARS);
      await addDoc(collection(db, "re_transactions"), {
        ...form, type,
        amountARS: ars,
        amountUSD: arsToUsd(ars, tc),
        exchangeRateUsed: tc,
        createdAt: serverTimestamp(),
      });
      await reload();
      setShowForm(false);
      setAmountARS("");
      setForm({ propertyId: "", category: "rent", date: today(), description: "" });
    } catch { setError("Error al guardar."); }
    finally { setSaving(false); }
  }

  const filtered = filter === "all" ? transactions : transactions.filter(t => t.type === filter);
  const propName = id => properties.find(p => p.id === id)?.name || id;
  const catLabel = { rent:"Alquiler",booking:"Reserva",expensas:"Expensas",expensas_extraordinarias:"Expensas ext.",impuesto:"Impuesto",reparacion:"Reparación",comision:"Comisión",limpieza:"Limpieza",seguro:"Seguro",otros:"Otros" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Transacciones</h1>
          <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{transactions.length} registros</p>
        </div>
        <button onClick={() => setShowForm(true)} style={S.btn}>+ Nueva transacción</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
        <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Ingresos</p><p style={{ fontSize: 20, fontWeight: 700, color: "#16a34a", margin: 0 }}>{fUSD(totals.income)}</p></div>
        <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Egresos</p><p style={{ fontSize: 20, fontWeight: 700, color: "#dc2626", margin: 0 }}>{fUSD(totals.expenses)}</p></div>
        <div style={S.metric}><p style={{ fontSize: 11, color: "#888", margin: "0 0 4px" }}>Neto</p><p style={{ fontSize: 20, fontWeight: 700, color: totals.income - totals.expenses >= 0 ? "#16a34a" : "#dc2626", margin: 0 }}>{fUSD(totals.income - totals.expenses)}</p></div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {["all","income","expense"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid", fontSize: 13, cursor: "pointer",
              background: filter === f ? "#f0fdf4" : "#fff",
              color: filter === f ? "#15803d" : "#555",
              borderColor: filter === f ? "#bbf7d0" : "#e5e7eb" }}>
            {{ all:"Todos", income:"Ingresos", expense:"Egresos" }[f]}
          </button>
        ))}
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <p style={{ color: "#aaa", textAlign: "center", padding: 40, fontSize: 13 }}>No hay transacciones</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["Fecha","Propiedad","Descripción","Categoría","ARS","USD"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "#888", fontWeight: 500, borderBottom: "1px solid #f1f5f9" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} style={{ borderBottom: "1px solid #f8fafc" }}>
                  <td style={{ padding: "10px 14px", color: "#888" }}>{t.date}</td>
                  <td style={{ padding: "10px 14px" }}>{propName(t.propertyId)}</td>
                  <td style={{ padding: "10px 14px", fontWeight: 500 }}>{t.description}</td>
                  <td style={{ padding: "10px 14px" }}><span style={{ background: "#f1f5f9", color: "#555", padding: "2px 8px", borderRadius: 6, fontSize: 11 }}>{catLabel[t.category] || t.category}</span></td>
                  <td style={{ padding: "10px 14px", color: "#555" }}>{fARS(t.amountARS)}</td>
                  <td style={{ padding: "10px 14px", fontWeight: 600, color: t.type === "income" ? "#16a34a" : "#dc2626" }}>{t.type === "income" ? "+" : "−"}{fUSD(t.amountUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Nueva transacción</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 14 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {["income","expense"].map(t => (
                  <button key={t} onClick={() => { setType(t); setF("category", t === "income" ? "rent" : "expensas"); }}
                    style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid", cursor: "pointer", fontWeight: 500, fontSize: 14,
                      background: type === t ? (t === "income" ? "#f0fdf4" : "#fef2f2") : "#fff",
                      color: type === t ? (t === "income" ? "#15803d" : "#dc2626") : "#555",
                      borderColor: type === t ? (t === "income" ? "#bbf7d0" : "#fecaca") : "#e5e7eb" }}>
                    {t === "income" ? "Ingreso" : "Egreso"}
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
                {amountARS > 0 && <p style={{ fontSize: 11, color: "#888", marginTop: 4 }}>≈ {fUSD(arsToUsd(Number(amountARS), tc))} al tipo ${tc.toLocaleString("es-AR")}</p>}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1 }}>{saving ? "Guardando..." : "Guardar"}</button>
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
  const [years, setYears]   = useState(20);

  const props = propId === "all" ? properties : properties.filter(p => p.id === propId);
  const txs   = propId === "all" ? transactions : transactions.filter(t => t.propertyId === propId);

  const totalVal  = props.reduce((s, p) => s + p.estimatedValueUSD, 0);
  const grossInc  = txs.filter(t => t.type === "income").reduce((s, t) => s + t.amountUSD, 0) / 3;
  const expenses  = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amountUSD, 0) / 3;
  const netInc    = grossInc - expenses;
  const annualNet = netInc * 12;
  const grossY    = totalVal > 0 ? (grossInc * 12 / totalVal) * 100 : 0;
  const netY      = totalVal > 0 ? (annualNet / totalVal) * 100 : 0;
  const irr       = calcIRR(totalVal, annualNet, totalVal, years);

  const projection = Array.from({ length: years }, (_, i) => {
    const year = i + 1;
    const cum = -totalVal + annualNet * year;
    return { year, cum: Math.round(cum), net: Math.round(annualNet), inc: Math.round(grossInc * 12), exp: Math.round(expenses * 12), recovered: cum >= 0 };
  });
  const pbYear = projection.find(r => r.recovered)?.year;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Análisis financiero</h1>
          <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>TIR · Payback · Cap Rate</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <select style={{ ...S.input, width: 180 }} value={propId} onChange={e => setPropId(e.target.value)}>
            <option value="all">Todo el portfolio</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 13, color: "#555" }}>Años:</label>
            <input type="number" min={5} max={40} value={years} onChange={e => setYears(Number(e.target.value))}
              style={{ ...S.input, width: 60, textAlign: "center" }} />
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Cap Rate",          value: fPct(netY),    color: netY > 4 ? "#16a34a" : "#ca8a04" },
          { label: "TIR",               value: fPct(irr),     color: irr > 6 ? "#16a34a" : irr > 3 ? "#ca8a04" : "#dc2626" },
          { label: "Rentabilidad neta", value: fPct(netY),    color: "#111" },
          { label: "Payback",           value: pbYear ? `Año ${pbYear}` : "N/A", color: "#111" },
        ].map(({ label, value, color }) => (
          <div key={label} style={S.card}>
            <p style={{ fontSize: 11, color: "#888", margin: "0 0 8px" }}>{label}</p>
            <p style={{ fontSize: 22, fontWeight: 700, color, margin: 0 }}>{value}</p>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div style={S.card}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px" }}>Flujo mensual (USD)</h2>
          {[
            { label: "Ingreso bruto / mes",  value: fUSD(grossInc), color: "#111" },
            { label: "Egresos / mes",        value: `− ${fUSD(expenses)}`, color: "#dc2626" },
            { label: "Ingreso neto / mes",   value: fUSD(netInc),   color: "#16a34a" },
            { label: "Ingreso neto / año",   value: fUSD(annualNet), color: "#16a34a" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
              <span style={{ fontSize: 13, color: "#666" }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color }}>{value}</span>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px" }}>Rentabilidad</h2>
          {[
            { label: "Rentabilidad bruta",  value: fPct(grossY) },
            { label: "Rentabilidad neta",   value: fPct(netY) },
            { label: "Cap Rate",            value: fPct(netY) },
            { label: "TIR",                 value: fPct(irr) },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
              <span style={{ fontSize: 13, color: "#666" }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tabla flujo de caja */}
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid #f1f5f9" }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Proyección · {years} años</h2>
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ position: "sticky", top: 0, background: "#f8fafc" }}>
              <tr>
                {["Año","Ingresos","Egresos","Neto","Acumulado"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "#888", fontWeight: 500, borderBottom: "1px solid #f1f5f9" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projection.map(r => {
                const isPayback = r.recovered && !projection[r.year-2]?.recovered;
                return (
                  <tr key={r.year} style={{ background: isPayback ? "#f0fdf4" : "transparent", borderBottom: "1px solid #f8fafc" }}>
                    <td style={{ padding: "8px 14px", color: "#888" }}>Año {r.year}</td>
                    <td style={{ padding: "8px 14px", color: "#16a34a" }}>{fUSD(r.inc)}</td>
                    <td style={{ padding: "8px 14px", color: "#dc2626" }}>−{fUSD(r.exp)}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 500 }}>{fUSD(r.net)}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 600, color: r.cum >= 0 ? "#16a34a" : "#dc2626" }}>
                      {r.cum >= 0 ? "+" : ""}{fUSD(r.cum)}
                      {isPayback && <span style={{ marginLeft: 8, background: "#dcfce7", color: "#15803d", fontSize: 10, padding: "2px 6px", borderRadius: 6 }}>Recupero</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
