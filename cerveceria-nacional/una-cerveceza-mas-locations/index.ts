import { define, z } from "@jelou/functions";
import got from "got";
import _ from "lodash";

const canjeTipo2 = async (
  apiKey: string,
  baseRecords: string,
  page: number,
) => {
  const url = `${baseRecords}/pbc_3925232346/records?page=${page}&perPage=500&sort=-created`;

  const res = await got.get(url, {
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
  });
  return res.body;
};

const canjeTipo1 = async (
  apiKey: string,
  baseRecords: string,
  page: number,
) => {
  const url = `${baseRecords}/pbc_1772491105/records?page=${page}&perPage=500&sort=-created`;

  const res = await got.get(url, {
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
  });
  return res.body;
};

async function fetchAllCanjeTipo2(
  apiKey: string,
  baseRecords: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const records = await canjeTipo2(apiKey, baseRecords, page);
    const data = JSON.parse(records) as Record<string, unknown>;
    totalPages = _.get(data, "totalPages", 1);
    out.push(..._.get(data, "items", []));
    page++;
  }
  return out;
}

async function fetchAllCanjeTipo1(
  apiKey: string,
  baseRecords: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const records = await canjeTipo1(apiKey, baseRecords, page);
    const data = JSON.parse(records) as Record<string, unknown>;
    totalPages = _.get(data, "totalPages", 1);
    out.push(..._.get(data, "items", []));
    page++;
  }
  return out;
}

export default define({
  description: "Top 10 locations by canje type",
  input: z.object({}),
  output: z.object({
    items: z.array(z.record(z.unknown())),
  }),
  handler: async (_input, ctx) => {
    const apiKey = ctx.env.get("CN_ENCUESTA_SEGUIMIENTO_API_KEY") ?? "";
    const baseRecords =
      "https://encuesta-de-seguimiento-rt8u44.jelou.cloud/api/collections";

    const [tipo2, tipo1] = await Promise.all([
      fetchAllCanjeTipo2(apiKey, baseRecords),
      fetchAllCanjeTipo1(apiKey, baseRecords),
    ]);
    const items = [...tipo2, ...tipo1];
    return items;
  },
});
