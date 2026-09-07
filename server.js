// server.js GitHub API helper

const https = require("https");
const fs = require("fs");
const config = require("./config");

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────

function githubRequest(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "FlutterBuildBot/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : {} });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: raw });
        }
      });
      res.on("error", reject);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("githubRequest timeout"));
    });

    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── UPLOAD ASSET ─────────────────────────────────────────────────────────────
function uploadAsset(uploadUrl, filePath, fileName, contentType = "application/zip") {
  return new Promise((resolve, reject) => {
    const cleanUrl = uploadUrl.replace("{?name,label}", "");
    const url = new URL(`${cleanUrl}?name=${encodeURIComponent(fileName)}`);

    const fileData = fs.readFileSync(filePath);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        "Content-Type": contentType,
        "Content-Length": fileData.length,
        "User-Agent": "FlutterBuildBot/1.0",
        Accept: "application/vnd.github+json",
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ status: res.statusCode, body });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(fileData);
    req.end();
  });
}

// JEMBATAN FIX: Fungsi helper yang dipanggil oleh modul Web2Apk / index.js
async function uploadAssetFile(uploadUrl, filePath, fileName, contentType = "image/png") {
  const upload = await uploadAsset(uploadUrl, filePath, fileName, contentType);
  if (upload.status !== 201) {
    throw new Error(`Gagal upload asset file: ${JSON.stringify(upload.body)}`);
  }
  return {
    id: upload.body.id,
    url: upload.body.url,
    browserUrl: upload.body.browser_download_url
  };
}

// ─── RELEASE FUNCTIONS ────────────────────────────────────────────────────────
async function createRelease(tagName, isDraft = true) {
  const res = await githubRequest(
    "POST",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/releases`,
    {
      tag_name: tagName,
      name: `Build ${tagName}`,
      draft: isDraft,
      prerelease: true,
      generate_release_notes: false,
    }
  );

  if (res.status !== 201) {
    throw new Error(`Gagal buat release: ${JSON.stringify(res.body)}`);
  }

  return {
    releaseId: res.body.id,
    uploadUrl: res.body.upload_url,
    htmlUrl: res.body.html_url,
  };
}

// Digunakan oleh Web2Apk untuk membuat container release awal secara senyap
async function createReleaseOnly(tagName) {
  try {
    return await createRelease(tagName, true);
  } catch (err) {
    // Coba hapus release lama dengan tag yang sama, lalu buat ulang
    const existing = await githubRequest(
      "GET",
      `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/releases/tags/${tagName}`
    );
    if (existing.status === 200) {
      await deleteRelease(existing.body.id);
    }
    return await createRelease(tagName, true);
  }
}

async function publishRelease(releaseId) {
  const check = await githubRequest(
    "GET",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/releases/${releaseId}`
  );

  if (check.status === 404) {
    throw new Error(`Release ID ${releaseId} tidak ditemukan (sudah terhapus atau tidak valid)`);
  }

  if (check.status === 200 && !check.body.draft) {
    const asset = check.body.assets?.[0];
    return asset ? asset.browser_download_url : null;
  }

  const res = await githubRequest(
    "PATCH",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/releases/${releaseId}`,
    { draft: false }
  );

  if (res.status !== 200) {
    throw new Error(`Gagal publish release: HTTP ${res.status} - ${JSON.stringify(res.body)}`);
  }

  const asset = res.body.assets?.[0];
  return asset ? asset.browser_download_url : null;
}

async function uploadZipToRelease(filePath, fileName, tagName) {
  const release = await createRelease(tagName, true);
  const upload = await uploadAsset(release.uploadUrl, filePath, fileName, "application/zip");

  if (upload.status !== 201) {
    throw new Error(`Gagal upload asset: ${JSON.stringify(upload.body)}`);
  }

  return {
    releaseId: release.releaseId, // FIX: was release.id (undefined), sekarang release.releaseId
    assetId: upload.body.id,
    assetUrl: upload.body.url,
    browserUrl: upload.body.url,
  };
}

async function deleteRelease(releaseId) {
  await githubRequest(
    "DELETE",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/releases/${releaseId}`
  );
}

// ─── WORKFLOW FUNCTIONS ───────────────────────────────────────────────────────
async function triggerWorkflow(assetUrl, tagName, buildType = "release") {
  const beforeTrigger = new Date().toISOString();

  const res = await githubRequest(
    "POST",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/workflows/build.yml/dispatches`,
    {
      ref: "main",
      inputs: {
        zip_url: assetUrl,
        tag: tagName,
        build_type: buildType
      },
    }
  );

  if (res.status !== 204) {
    throw new Error(`Gagal trigger workflow: ${JSON.stringify(res.body)}`);
  }

  return await waitForNewRunId(beforeTrigger, 30000);
}

async function triggerWeb2ApkWorkflow(webUrl, appName, iconUrl) {
  const beforeTrigger = new Date().toISOString();

  const res = await githubRequest(
    "POST",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/workflows/web2apk.yml/dispatches`,
    {
      ref: "main",
      inputs: {
        web_url: webUrl,
        app_name: appName,
        icon_url: iconUrl
      },
    }
  );

  if (res.status !== 204) {
    throw new Error(`Gagal trigger Web2Apk workflow: ${JSON.stringify(res.body)}`);
  }

  return await waitForNewRunId(beforeTrigger, 30000);
}

async function waitForNewRunId(since, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(3000);

    const res = await githubRequest(
      "GET",
      `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/runs?per_page=5&event=workflow_dispatch`
    );

    const runs = res.body.workflow_runs || [];
    const newRun = runs.find((r) => new Date(r.created_at) >= new Date(since));
    if (newRun) return newRun.id;
  }

  throw new Error("Workflow run tidak muncul setelah 30 detik. Cek GitHub Actions repo kamu.");
}

// ─── RUN STATUS ───────────────────────────────────────────────────────────────
async function getRunStatus(runId) {
  const res = await githubRequest(
    "GET",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/runs/${runId}`
  );
  const r = res.body;
  return {
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    durationSec:
      r.created_at && r.updated_at
        ? Math.round((new Date(r.updated_at) - new Date(r.created_at)) / 1000)
        : 0,
  };
}

// ─── ARTIFACTS ────────────────────────────────────────────────────────────────
async function getArtifacts(runId) {
  const res = await githubRequest(
    "GET",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/runs/${runId}/artifacts`
  );
  return res.body.artifacts || [];
}

function downloadArtifactZip(artifactId, destPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/artifacts/${artifactId}/zip`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "FlutterBuildBot/1.0",
      },
    };

    function get(opts, useHttps = true) {
      const mod = useHttps ? https : require("http");
      const req = mod.request(opts, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error("Redirect tanpa Location header"));
          res.resume();
          const u = new URL(loc);
          get(
            {
              hostname: u.hostname,
              path: u.pathname + u.search,
              method: "GET",
              headers: { "User-Agent": "FlutterBuildBot/1.0" },
            },
            u.protocol === "https:"
          );
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download artifact gagal: HTTP ${res.statusCode}`));
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
        res.on("error", reject);
      });

      req.on("error", reject);
      req.end();
    }

    get(options);
  });
}

// ─── FAILED STEP LOG ──────────────────────────────────────────────────────────
async function getFailedStepLog(runId) {
  try {
    const result = await Promise.race([
      _getFailedStepLog(runId),
      new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
    ]);
    return result;
  } catch (err) {
    console.error("getFailedStepLog error:", err.message);
    return null;
  }
}

async function _getFailedStepLog(runId) {
  const jobsRes = await githubRequest(
    "GET",
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/runs/${runId}/jobs`
  );

  const jobs = jobsRes.body.jobs || [];
  const failedJob = jobs.find((j) => j.conclusion === "failure");
  if (!failedJob) return null;

  const failedStep = failedJob.steps?.find((s) => s.conclusion === "failure");
  const stepName = failedStep?.name || failedJob.name;

  const logText = await fetchLogWithRedirect(
    `/repos/${config.GITHUB_USERNAME}/${config.GITHUB_REPO}/actions/jobs/${failedJob.id}/logs`
  );

  if (!logText) return { stepName, hasDetails: false, errorLines: [] };

  const allLines = logText.split("\n")
    .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, ''))
    .map(line => line.trim());

  let errorLines = [];

  const startAnalyze = allLines.findIndex(l => l.includes("[RESULT_ANALYZE]"));
  const endAnalyze = allLines.findIndex(l => l.includes("[END_RESULT_ANALYZE]"));

  if (startAnalyze !== -1 && endAnalyze !== -1) {
    const analyzeBody = allLines.slice(startAnalyze + 1, endAnalyze)
      .filter(line => {
        const l = line.toLowerCase();
        return l.includes("error") || l.includes("warning") || l.includes("info");
      });

    if (analyzeBody.length > 0) {
      errorLines = analyzeBody.map(l => `🔍 ${l}`);
    } else {
      errorLines = ["✅ Kodingan lu bersih bray! Kagak ada error/warning linting sama sekali."];
    }
  }

  if (errorLines.length === 0) {
    const cleanLines = logText.split("\n")
      .filter((l) => l.trim())
      .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, ''))
      .filter(line => {
        const l = line.toLowerCase();
        return !l.includes("##[") &&
               !l.includes("deprecation") &&
               !l.includes("orphan process") &&
               !l.includes("post job cleanup") &&
               !l.includes("punycode") &&
               !l.includes("failure: build failed") &&
               !l.includes("compileflutterbuildrelease");
      });

    errorLines = cleanLines.slice(-50);
  }

  return { stepName, hasDetails: errorLines.length > 0, errorLines };
}

function fetchLogWithRedirect(apiPath) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);

    function get(hostname, path, useAuth) {
      const headers = { "User-Agent": "FlutterBuildBot/1.0" };
      if (useAuth) {
        headers["Authorization"] = `Bearer ${config.GITHUB_TOKEN}`;
        headers["Accept"] = "application/vnd.github+json";
      }

      const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          const loc = res.headers.location;
          res.resume();
          if (!loc) { clearTimeout(timeout); return resolve(null); }
          const u = new URL(loc);
          return get(u.hostname, u.pathname + u.search, false);
        }

        if (res.statusCode !== 200) {
          res.resume();
          clearTimeout(timeout);
          return resolve(null);
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timeout);
          resolve(Buffer.concat(chunks).toString());
        });
        res.on("error", () => { clearTimeout(timeout); resolve(null); });
      });

      req.on("error", () => { clearTimeout(timeout); resolve(null); });
      req.setTimeout(8000, () => { req.destroy(); clearTimeout(timeout); resolve(null); });
      req.end();
    }

    get("api.github.com", apiPath, true);
  });
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  githubRequest,
  uploadZipToRelease,
  deleteRelease,
  triggerWorkflow,
  getRunStatus,
  getArtifacts,
  downloadArtifactZip,
  getFailedStepLog,
  sleep,
  createReleaseOnly,
  uploadAssetFile,
  publishRelease,
  triggerWeb2ApkWorkflow,
};