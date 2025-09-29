import axios from "axios";

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Use POST" }) };
    }
    const { fileUrl, target } = JSON.parse(event.body || "{}");
    if (!fileUrl || !target) {
      return { statusCode: 400, body: JSON.stringify({ error: "Provide fileUrl and target" }) };
    }
    const apiKey = process.env.CLOUDCONVERT_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing CLOUDCONVERT_API_KEY" }) };
    }

    // 1) Create job (import/url -> convert -> export/url)
    const jobRes = await axios.post("https://api.cloudconvert.com/v2/jobs", {
      tasks: {
        "import-1": { operation: "import/url", url: fileUrl },
        "convert-1": { operation: "convert", input: "import-1", output_format: target },
        "export-1": { operation: "export/url", input: "convert-1", inline: false, archive_multiple_files: false }
      }
    }, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } });

    const jobId = jobRes.data?.data?.id;
    if (!jobId) return { statusCode: 500, body: JSON.stringify({ error: "Failed to create job" }) };

    // 2) Poll until finished
    let done = false, fileOut = null;
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const j = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const exportTask = j.data?.data?.tasks?.find(t => t.name === "export-1" && t.status === "finished");
      if (exportTask?.result?.files?.[0]) {
        fileOut = exportTask.result.files[0];
        done = true;
      }
      const failed = j.data?.data?.status === "error";
      if (failed) break;
    }

    if (!fileOut) {
      return { statusCode: 500, body: JSON.stringify({ error: "Conversion not finished or failed" }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        downloadUrl: fileOut.url,
        filename: fileOut.filename,
        sizeBytes: fileOut.size,
        contentType: fileOut.content_type
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server error", details: e?.message }) };
  }
};
