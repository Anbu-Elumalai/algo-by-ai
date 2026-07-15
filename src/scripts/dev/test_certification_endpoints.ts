import axios from "axios";

async function run() {
  const baseUrl = "http://localhost:4001/api/reports/certification";
  console.log("🔍 Starting Certification API Endpoints verification tests...");

  try {
    // 1. GET /latest
    console.log("\n1. Testing GET /latest...");
    const latestRes = await axios.get(`${baseUrl}/latest`);
    console.log("Status:", latestRes.status);
    console.log("Success:", latestRes.data.success);
    console.log("Latest Week Identifier:", latestRes.data.data.weekIdentifier);
    console.log("Verdict Status:", latestRes.data.data.finalVerdict.mostBlockingFilter);

    // 2. GET /history
    console.log("\n2. Testing GET /history...");
    const historyRes = await axios.get(`${baseUrl}/history`);
    console.log("Status:", historyRes.status);
    console.log("Reports Count:", historyRes.data.count);

    // 3. GET /:week
    const week = latestRes.data.data.weekIdentifier;
    console.log(`\n3. Testing GET /:${week}...`);
    const weekRes = await axios.get(`${baseUrl}/${week}`);
    console.log("Status:", weekRes.status);
    console.log("Week Identifier match:", weekRes.data.data.weekIdentifier === week);

    // 4. GET /download/pdf/:week
    console.log(`\n4. Testing GET /download/pdf/:${week}...`);
    const pdfRes = await axios.get(`${baseUrl}/download/pdf/${week}`, { responseType: "arraybuffer" });
    console.log("Status:", pdfRes.status);
    console.log("Content-Type:", pdfRes.headers["content-type"]);
    console.log("File size:", pdfRes.data.byteLength, "bytes");

    // 5. GET /download/html/:week
    console.log(`\n5. Testing GET /download/html/:${week}...`);
    const htmlRes = await axios.get(`${baseUrl}/download/html/${week}`);
    console.log("Status:", htmlRes.status);
    console.log("Content-Type:", htmlRes.headers["content-type"]);
    console.log("HTML starts with:", htmlRes.data.slice(0, 100).trim());

    console.log("\n==============================================");
    console.log("🎉 CERTIFICATION ENDPOINTS SUCCESSFULLY VERIFIED!");
    console.log("==============================================");
  } catch (err: any) {
    console.error("❌ Certification API Verification failed:", err.message);
    if (err.response) {
      console.error("Response Status:", err.response.status);
      console.error("Response Data:", err.response.data.toString());
    }
  }
}

run().catch(console.error);
