/** Témoin de connexion des postes de contrôle : répond sans authentification ni base. */
export function GET() {
  return Response.json({ ok: true, time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
