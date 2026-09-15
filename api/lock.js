// Endpoint SEGURO para operar la cerradura sin exponer las credenciales al navegador.
// Las credenciales de TTLock viven en variables de entorno de Vercel.
// Solo usuarios logueados y autorizados pueden usarlo.
//   - LOCK_ALLOWED_EMAILS: co-anfitriones (generar códigos, estado, accesos, borrar).
//   - LOCK_OWNER_EMAILS:  propietarios (todo lo anterior + abrir/cerrar la puerta).
import crypto from "crypto";

const md5 = (s) => crypto.createHash("md5").update(String(s)).digest("hex");
const parseList = (v) => (v || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Método no permitido" }); return; }
  try {
    const { idToken, action, params = {} } = req.body || {};

    // 1) Verificar que el que llama es un usuario logueado y autorizado
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!idToken) { res.status(401).json({ error: "No se recibió el token de sesión. Recargá la página e iniciá sesión de nuevo." }); return; }
    if (!apiKey) { res.status(500).json({ error: "Falta la variable FIREBASE_API_KEY en Vercel (Settings → Environment Variables) y hacé Redeploy." }); return; }
    const vr = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
    });
    const vd = await vr.json();
    const email = ((vd.users && vd.users[0] && vd.users[0].email) || "").toLowerCase();
    const owners = parseList(process.env.LOCK_OWNER_EMAILS);
    const allowed = parseList(process.env.LOCK_ALLOWED_EMAILS);
    const isOwner = owners.includes(email);
    const authorized = !!email && (isOwner || allowed.includes(email));
    if (!authorized) { res.status(403).json({ error: "No autorizado" }); return; }
    // Abrir/cerrar la puerta: solo propietario
    if ((action === "open" || action === "close") && !isOwner) { res.status(403).json({ error: "Solo el propietario puede abrir o cerrar la puerta" }); return; }

    // 2) Credenciales de TTLock (solo en el servidor)
    const clientId = process.env.TTLOCK_CLIENT_ID;
    const clientSecret = process.env.TTLOCK_CLIENT_SECRET;
    const username = process.env.TTLOCK_USERNAME;
    const password = md5(process.env.TTLOCK_PASSWORD || "");
    const lockId = process.env.TTLOCK_LOCK_ID;
    if (!clientId || !username || !lockId) { res.status(500).json({ error: "Faltan variables de entorno de TTLock" }); return; }

    const tr = await fetch("https://euapi.ttlock.com/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ clientId, clientSecret, username, password, grant_type: "password" }),
    });
    const td = await tr.json();
    if (!td.access_token) { res.status(200).json({ error: td.errmsg || "No se pudo autenticar en TTLock" }); return; }
    const t = td.access_token;
    const base = "https://euapi.ttlock.com/v3";
    const g = (path, q) => fetch(`${base}${path}?` + new URLSearchParams({ clientId, accessToken: t, lockId, ...q, date: Date.now() })).then(r => r.json());
    const p = (path, q) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ clientId, accessToken: t, lockId, ...q, date: Date.now() }) }).then(r => r.json());

    let out;
    if (action === "status") {
      const s = await g("/lock/queryOpenState", {});
      let battery = null; try { const b = await g("/lock/queryElectricQuantity", {}); battery = b.electricQuantity; } catch (e) {}
      out = { state: s.state, battery, isOwner };
    } else if (action === "records") {
      out = await g("/lockRecord/list", { pageNo: 1, pageSize: 50 });
    } else if (action === "createGuestPin") {
      const pin = String(params.codigo || Math.floor(100000 + Math.random() * 900000));
      const d = await p("/keyboardPwd/add", { keyboardPwd: pin, keyboardPwdName: params.nombre || "Huésped", startDate: params.startDate, endDate: params.endDate, addType: 2 });
      out = { ...d, keyboardPwd: pin };
    } else if (action === "deletePin") {
      out = await p("/keyboardPwd/delete", { keyboardPwdId: params.keyboardPwdId, deleteType: 2 });
    } else if (action === "open") {
      out = await p("/lock/unlock", {});
    } else if (action === "close") {
      out = await p("/lock/lock", {});
    } else {
      res.status(400).json({ error: "Acción inválida" }); return;
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
}
