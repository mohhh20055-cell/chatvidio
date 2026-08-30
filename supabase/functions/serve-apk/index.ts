// serve-apk: serves APK download or redirects to external URL
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: settingsData } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "app_download")
      .single();

    const externalUrl = settingsData?.value?.url;
    const isActive = settingsData?.value?.active;

    if (isActive && externalUrl && externalUrl.length > 0) {
      return new Response(null, {
        status: 302,
        headers: { ...corsHeaders, Location: externalUrl },
      });
    }

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from("app-downloads")
      .download("zoomdz.apk");

    if (fileError || !fileData) {
      return new Response(
        JSON.stringify({
          error: "ملف التطبيق غير متوفر حالياً",
          hint: "يمكنك استخدام رابط خارجي في إعدادات platform_settings",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="zoomdz.apk"',
        "Content-Length": bytes.byteLength.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "خطأ في الخادم" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
