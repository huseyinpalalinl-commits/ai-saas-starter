import { NextResponse } from "next/server";

// Reference images are converted to base64 data URLs and sent straight to the
// generation pipeline; no external CDN is involved.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    if (!file.type?.startsWith("image/")) {
      return NextResponse.json({ error: "Only image files are allowed" }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Image must be smaller than 4 MB" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64Url = `data:${file.type};base64,${buffer.toString("base64")}`;
    return NextResponse.json({ url: base64Url });
  } catch (error) {
    console.error("File upload error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
