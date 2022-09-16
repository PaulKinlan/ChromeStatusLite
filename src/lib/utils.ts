import { StripStream } from "../stream-utils.ts";

export const getChannels = (start?: number, end?: number) => {
  let queryString = "";
  if (start != undefined && end != undefined) {
    queryString = `?start=${start}&end=${end}`;
  }

  return fetch(`https://chromestatus.com/api/v0/channels${queryString}`)
    .then(response => new Response(response.body.pipeThrough(new StripStream()), {
      status: 200, headers: {
        'content-type': 'application/json'
      }
    }))
    .then(response => response.json());
}

export const getVersions = async () => {
  const versionData = await getChannels();
  const lastVersion = Number.parseInt(versionData.canary.version);

  return [...Array(lastVersion).keys()].reverse();
};

export const getFeatures = () => {
  return getFeaturesForVersion();
};

export const getFeaturesForVersion = (version?: number) => {
  let queryString = ""
  if (version != undefined) {
    queryString = `?milestone=${version}`;
  }

  const url = `https://chromestatus.com/api/v0/features${queryString}`;

  return fetch(url)
    .then(resposnse => new Response(resposnse.body.pipeThrough(new StripStream()), {
      status: 200, headers: {
        'content-type': 'application/json'
      }
    }))
    .then(response => response.json());
};