// Proxy serverless para la API de TTLock (evita el bloqueo CORS del navegador).
// El frontend llama a /api/ttlock con { path, method, params } y esta función
// reenvía la llamada a euapi.ttlock.com desde el servidor (sin CORS).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ __proxyError: "Método no permitido" });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { path, method = "GET", params = {} } = body || {};
    if (!path || typeof path !== "string" || !path.startsWith("/")) {
      res.status(400).json({ __proxyError: "Ruta inválida" });
      return;
    }
    const base = "https://euapi.ttlock.com";
    let url = base + path;
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) usp.append(k, String(params[k]));
    });

    const m = (method || "GET").toUpperCase();
    const opts = { method: m };
    if (m === "GET") {
      url += (url.includes("?") ? "&" : "?") + usp.toString();
    } else {
      opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      opts.body = usp.toString();
    }

    const r = await fetch(url, opts);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { data = { __proxyError: "Respuesta no-JSON de TTLock", status: r.status, raw: String(text).slice(0, 300) }; }
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ __proxyError: String((e && e.message) || e) });
  }
}
