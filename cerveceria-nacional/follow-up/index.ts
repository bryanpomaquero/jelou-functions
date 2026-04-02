import { define, z } from "@jelou/functions";
import got from "got";
import pLimit from "p-limit";

const MS_24H = 24 * 60 * 60 * 1000;
const MS_48H = 48 * 60 * 60 * 1000;

const syncResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  status: z.number().optional(),
  error: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  stage: z.enum(["first", "second"]).optional(),
  counterAfter: z.number().optional(),
});

function parseCreated(created: unknown): Date | null {
  const s = String(created ?? "");
  if (!s) return null;
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Primer HSM: counter 0 y ≥24h desde created. Segundo: counter 1 y ≥48h desde created. */
function resolveHsmStage(
  item: Record<string, unknown>,
  now: Date,
): "first" | "second" | null {
  const counter = Number(item.counter ?? 0);
  const created = parseCreated(item.created);
  if (!created) return null;

  const elapsed = now.getTime() - created.getTime();
  console.log("elapsed", { elapsed });
  console.log("counter", { counter });
  if (counter === 0 ) return "first";
  if (counter === 1 && elapsed >= MS_48H) return "second";
  return null;
}

function buildHsmPayload(
  item: Record<string, unknown>,
  ctx: { env: { get: (k: string) => string | undefined } },
  stage: "first" | "second",
) {
  const elementName =
    stage === "second"
      ? (ctx.env.get("HSM_ELEMENT_NAME_SECOND") ??
        ctx.env.get("HSM_ELEMENT_NAME") ??
        "mi_plantilla")
      : (ctx.env.get("HSM_ELEMENT_NAME") ?? "mi_plantilla");

  const language = ctx.env.get("HSM_LANGUAGE") ?? "es";
  const skillConfirm = ctx.env.get("HSM_SKILL_ID_CONFIRM") ?? "1";
  const skillCancel = ctx.env.get("HSM_SKILL_ID_CANCEL") ?? "2";

  const nameStore = String(item.nameStore ?? "");
  const recordId = String(item.id ?? "");
  const userId = String(item.userId ?? "");

  return {
    elementName,
    language,
    type: "text" as const,
    parameters: [nameStore, recordId],
    destinations: [userId],
    buttonParameters: [
      {
        type: "QUICK_REPLY" as const,
        payload: {
          type: "edge" as const,
          action: "Confirmar",
          skillId: skillConfirm,
        },
      },
      {
        type: "QUICK_REPLY" as const,
        payload: {
          type: "edge" as const,
          action: "Cancelar",
          skillId: skillCancel,
        },
      },
    ],
  };
}

export default define({
  name: "encuesta-seguimiento-records",
  description:
    "HSM 1 tras 24h (counter 0→1), HSM 2 tras 48h (counter 1→2); actualiza counter vía PATCH",
  input: z.object({}),
  output: z.object({
    items: z.array(z.record(z.unknown())),
    sync: z.array(syncResultSchema),
  }),
  handler: async (_input, ctx) => {
    const recordsBaseUrl =
      ctx.env.get("ENCUESTA_COLLECTION_RECORDS_URL") ?? "";
    const apiKey = ctx.env.get("ENCUESTA_SEGUIMIENTO_API_KEY") ?? "";

    const hsmApiBaseUrl = ctx.env.get("JELOU_WHATSAPP_API_BASE_URL") ?? "";
    const botId = ctx.env.get("CERVECERIA_NACIONAL_BOT_ID") ?? "";
    const clientId = ctx.env.get("CERVECERIA_NACIONAL_CLIENT_ID") ?? "";
    const clientSecret = ctx.env.get("CERVECERIA_NACIONAL_CLIENT_SECRET") ?? "";


    const params = new URLSearchParams({
      page: "1",
      perPage: "50",
      sort: "-created",
    });
    params.set("filter", "(counter = 0 || counter = 1)");

    const baseRecords = recordsBaseUrl.replace(/\/$/, "");
    const listUrl = `${baseRecords}?${params.toString()}`;

    const res = await got.get(listUrl, {
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
      },
      throwHttpErrors: false,
    });

    if (!res.ok) {
      const text = String(res.body);
      ctx.log("Encuesta API error", { status: res.statusCode, body: text });
      throw new Error(`Encuesta API ${res.statusCode}: ${text.slice(0, 200)}`);
    }

    const data = JSON.parse(String(res.body)) as {
      page: number;
      perPage: number;
      totalItems: number;
      totalPages: number;
      items: Record<string, unknown>[];
    };

    const items = data.items ?? [];
    const limit = pLimit(5);
    const hsmUrl = `${hsmApiBaseUrl.replace(/\/$/, "")}/${botId}/hsm`;
    const now = new Date();

    const sync = await Promise.all(
      items.map((item) =>
        limit(async () => {
          const id = String(item.id ?? "");
          const userId = String(item.userId ?? "");

          const stage = resolveHsmStage(item, now);
          ctx.log("stage", { stage });
          if (!stage) {
            return {
              id,
              ok: true,
              skipped: true,
              reason:
                "No aplica: ventana 24h/48h o counter no es 0/1 según reglas",
            };
          }

          if (!userId) {
            return {
              id,
              ok: false,
              error: "userId vacío: no se puede enviar HSM",
            };
          }

          try {
            const body = buildHsmPayload(item, ctx, stage);
            const nextCounter = stage === "first" ? 1 : 2;

            // const out = await got.post(hsmUrl, {
            //   username: clientId,
            //   password: clientSecret,
            //   json: body,
            //   headers: {
            //     Accept: "application/json",
            //   },
            //   throwHttpErrors: false,
            // });

            // if (!out.ok) {
            //   const text = String(out.body);
            //   ctx.log("Jelou HSM error", {
            //     id,
            //     stage,
            //     status: out.statusCode,
            //     body: text.slice(0, 300),
            //   });
            //   return {
            //     id,
            //     ok: false,
            //     status: out.statusCode,
            //     error: text.slice(0, 500),
            //     stage,
            //   };
            // }

            const patchUrl = `${baseRecords}/${encodeURIComponent(id)}`;
            const patched = await got.patch(patchUrl, {
              headers: {
                "X-Api-Key": apiKey,
                Accept: "application/json",
              },
              json: { counter: nextCounter },
              throwHttpErrors: false,
            });

            if (!patched.ok) {
              const text = String(patched.body);
              ctx.log("PATCH counter falló tras HSM enviado", {
                id,
                status: patched.statusCode,
                body: text.slice(0, 300),
              });
              return {
                id,
                ok: false,
                status: patched.statusCode,
                error: `HSM enviado pero counter no actualizado: ${text.slice(0, 200)}`,
                stage,
              };
            }

            return {
              id,
              ok: true,
              stage,
              counterAfter: nextCounter,
            };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            ctx.log("HSM/PATCH failed", { id, error: message });
            return { id, ok: false, error: message };
          }
        }),
      ),
    );

    return {
      items,
      sync,
    };
  },
});
