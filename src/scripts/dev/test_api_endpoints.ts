import axios from "axios";

async function run() {
  const baseUrl = "http://localhost:4000/api/reports/weekly";
  console.log("🔍 Starting API Endpoints verification tests...");

  try {
    // 1. GET /latest
    console.log("\n1. Testing GET /latest...");
    const latestRes = await axios.get(`${baseUrl}/latest`);
    console.log("Status:", latestRes.status);
    console.log("Success:", latestRes.data.success);
    console.log("Latest Week:", latestRes.data.data.weekIdentifier);
    console.log("Generated At:", latestRes.data.data.generatedAt);

    // 2. GET /history
    console.log("\n2. Testing GET /history...");
    const historyRes = await axios.get(`${baseUrl}/history`);
    console.log("Status:", historyRes.status);
    console.log("Reports Count:", historyRes.data.count);

    // 3. GET /email/status
    console.log("\n3. Testing GET /email/status...");
    const statusRes = await axios.get(`${baseUrl}/email/status`);
    console.log("Status:", statusRes.status);
    console.log("Data sample:", JSON.stringify(statusRes.data.data[0], null, 2));

    // 4. GET /:week
    const week = latestRes.data.data.weekIdentifier;
    console.log(`\n4. Testing GET /:${week}...`);
    const weekRes = await axios.get(`${baseUrl}/${week}`);
    console.log("Status:", weekRes.status);
    console.log("Week Identifier match:", weekRes.data.data.weekIdentifier === week);

    // 5. GET /download/pdf/:week
    console.log(`\n5. Testing GET /download/pdf/:${week}...`);
    const pdfRes = await axios.get(`${baseUrl}/download/pdf/${week}`, { responseType: "arraybuffer" });
    console.log("Status:", pdfRes.status);
    console.log("Content-Type:", pdfRes.headers["content-type"]);
    console.log("File size:", pdfRes.data.byteLength, "bytes");

    // 6. GET /download/html/:week
    console.log(`\n6. Testing GET /download/html/:${week}...`);
    const htmlRes = await axios.get(`${baseUrl}/download/html/${week}`);
    console.log("Status:", htmlRes.status);
    console.log("Content-Type:", htmlRes.headers["content-type"]);
    console.log("HTML starts with:", htmlRes.data.slice(0, 100).trim());

    console.log("\n==============================================");
    console.log("🎉 ALL API ENDPOINTS SUCCESSFULLY VERIFIED!");
    console.log("==============================================");
  } catch (err: any) {
    console.error("❌ API Verification failed:", err.message);
    if (err.response) {
      console.error("Response Status:", err.response.status);
      console.error("Response Data:", err.response.data);
    }
  }
}

run().catch(console.error);
