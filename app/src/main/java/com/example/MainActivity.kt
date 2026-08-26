package com.example

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color as ComposeColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.example.ui.theme.MyApplicationTheme

class MainActivity : ComponentActivity() {

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var webView: WebView? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var originalSystemUiVisibility: Int = 0
    private var originalOrientation: Int = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var lastBackPressTime: Long = 0

    companion object {
        const val PRIMARY_URL = "https://zoomdz.com"
        const val BACKUP_URL = "https://zooooooom-mown.vercel.app"
        val TRUSTED_DOMAINS = listOf(
            "zoomdz.com",
            "www.zoomdz.com",
            "zooooooom-mown.vercel.app",
            "vercel.app",
            "run.app"
        )
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (filePathCallback != null) {
            val results = if (result.resultCode == RESULT_OK) {
                val dataString = result.data?.dataString
                val clipData = result.data?.clipData
                if (clipData != null) {
                    val count = clipData.itemCount
                    Array(count) { i -> clipData.getItemAt(i).uri }
                } else if (dataString != null) {
                    arrayOf(Uri.parse(dataString))
                } else {
                    null
                }
            } else {
                null
            }
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
    }

    private val requestPermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val cameraGranted = permissions[Manifest.permission.CAMERA] ?: false
        val audioGranted = permissions[Manifest.permission.RECORD_AUDIO] ?: false
        if (!cameraGranted || !audioGranted) {
            Toast.makeText(this, "يرجى تفعيل صلاحيات الكاميرا والمايكروفون للاستفادة الكاملة من البث المباشر والدروس التفاعلية", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.parseColor("#0B172A")
        window.navigationBarColor = Color.parseColor("#0B172A")

        requestEssentialPermissions()

        setContent {
            MyApplicationTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = ComposeColor(0xFF0B172A)
                ) {
                    ZoomDzMainScreen()
                }
            }
        }
    }

    @Composable
    private fun ZoomDzMainScreen() {
        var isLoading by remember { mutableStateOf(true) }
        var hasError by remember { mutableStateOf(false) }
        var currentUrl by remember { mutableStateOf(PRIMARY_URL) }
        var pageLoadProgress by remember { mutableStateOf(0) }

        BackHandler {
            handleBackNavigation()
        }

        Box(modifier = Modifier.fillMaxSize()) {
            ZoomDzWebView(
                url = currentUrl,
                onProgressChanged = { progress ->
                    pageLoadProgress = progress
                    if (progress >= 90) {
                        isLoading = false
                    }
                },
                onPageStarted = {
                    isLoading = true
                    hasError = false
                },
                onPageFinished = {
                    isLoading = false
                    hasError = false
                },
                onErrorOccurred = {
                    isLoading = false
                    hasError = true
                }
            )

            // Progress Bar at the top
            if (isLoading && pageLoadProgress in 1..99) {
                LinearProgressIndicator(
                    progress = { pageLoadProgress / 100f },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(3.dp)
                        .align(Alignment.TopCenter),
                    color = ComposeColor(0xFF3B82F6),
                    trackColor = ComposeColor.Transparent
                )
            }

            // Initial Loading Splash
            AnimatedVisibility(
                visible = isLoading && pageLoadProgress < 40,
                enter = fadeIn(),
                exit = fadeOut(animationSpec = tween(400))
            ) {
                NativeLoadingScreen()
            }

            // Offline & Connection Error Screen
            AnimatedVisibility(
                visible = hasError,
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                OfflineErrorScreen(
                    onRetry = {
                        hasError = false
                        isLoading = true
                        if (isOnline()) {
                            webView?.loadUrl(PRIMARY_URL)
                        } else {
                            Toast.makeText(this@MainActivity, "لا يوجد اتصال بالإنترنت حالياً", Toast.LENGTH_SHORT).show()
                            hasError = true
                            isLoading = false
                        }
                    }
                )
            }
        }
    }

    @Composable
    private fun NativeLoadingScreen() {
        val infiniteTransition = rememberInfiniteTransition(label = "loading")
        val rotation by infiniteTransition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = tween(1200, easing = LinearEasing),
                repeatMode = RepeatMode.Restart
            ),
            label = "rotation"
        )

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            ComposeColor(0xFF0B172A),
                            ComposeColor(0xFF0F172A)
                        )
                    )
                ),
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(100.dp)
                        .clip(CircleShape)
                        .background(
                            Brush.linearGradient(
                                colors = listOf(
                                    ComposeColor(0xFF2563EB),
                                    ComposeColor(0xFF1D4ED8)
                                )
                            )
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "ZoomDz",
                        color = ComposeColor.White,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                Spacer(modifier = Modifier.height(28.dp))

                CircularProgressIndicator(
                    color = ComposeColor(0xFF3B82F6),
                    strokeWidth = 3.5.dp,
                    modifier = Modifier.size(36.dp)
                )

                Spacer(modifier = Modifier.height(20.dp))

                Text(
                    text = "منصة ZoomDz التعليمية",
                    color = ComposeColor.White,
                    fontSize = 19.sp,
                    fontWeight = FontWeight.Bold
                )

                Spacer(modifier = Modifier.height(6.dp))

                Text(
                    text = "جاري الاتصال بالمنصة...",
                    color = ComposeColor(0xFF94A3B8),
                    fontSize = 14.sp
                )
            }
        }
    }

    @Composable
    private fun OfflineErrorScreen(onRetry: () -> Unit) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(ComposeColor(0xFF0B172A)),
            contentAlignment = Alignment.Center
        ) {
            Card(
                modifier = Modifier
                    .fillMaxWidth(0.9f)
                    .padding(16.dp),
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = ComposeColor(0xFF1E293B)),
                elevation = CardDefaults.cardElevation(8.dp)
            ) {
                Column(
                    modifier = Modifier.padding(28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Box(
                        modifier = Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(ComposeColor(0x22EF4444)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.WifiOff,
                            contentDescription = "No Internet",
                            tint = ComposeColor(0xFFEF4444),
                            modifier = Modifier.size(36.dp)
                        )
                    }

                    Spacer(modifier = Modifier.height(20.dp))

                    Text(
                        text = "تعذر الاتصال بالمنصة",
                        color = ComposeColor.White,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center
                    )

                    Spacer(modifier = Modifier.height(10.dp))

                    Text(
                        text = "يرجى التحقق من اتصال هاتفك بشبكة الإنترنت (Wi-Fi أو بيانات الهاتف) والمحاولة مجدداً.",
                        color = ComposeColor(0xFF94A3B8),
                        fontSize = 14.sp,
                        textAlign = TextAlign.Center,
                        lineHeight = 22.sp
                    )

                    Spacer(modifier = Modifier.height(24.dp))

                    Button(
                        onClick = onRetry,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(50.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = ComposeColor(0xFF2563EB))
                    ) {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = "Retry",
                            tint = ComposeColor.White,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "إعادة المحاولة",
                            color = ComposeColor.White,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }

    private fun isInternalUrl(url: String): Boolean {
        val uri = Uri.parse(url)
        val host = uri.host ?: return false
        return TRUSTED_DOMAINS.any { host.equals(it, ignoreCase = true) || host.endsWith(".$it") }
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    fun ZoomDzWebView(
        url: String,
        onProgressChanged: (Int) -> Unit,
        onPageStarted: () -> Unit,
        onPageFinished: () -> Unit,
        onErrorOccurred: () -> Unit
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    webView = this
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )

                    isVerticalScrollBarEnabled = false
                    isHorizontalScrollBarEnabled = false
                    setBackgroundColor(Color.parseColor("#0B172A"))

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val targetUrl = request?.url?.toString() ?: return false

                            // 1. Internal Platform Links -> Stay inside WebView
                            if (isInternalUrl(targetUrl) || targetUrl.startsWith("file://") || targetUrl.contains("localhost")) {
                                return false
                            }

                            // 2. Telegram Links (@zoomdz1 channel or bot)
                            if (targetUrl.contains("t.me/") || targetUrl.startsWith("tg:")) {
                                try {
                                    val tgIntent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                                    tgIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    ctx.startActivity(tgIntent)
                                    return true
                                } catch (e: Exception) {
                                    // Fallback to browser
                                }
                            }

                            // 3. WhatsApp Links
                            if (targetUrl.contains("whatsapp.com") || targetUrl.startsWith("whatsapp:") || targetUrl.contains("wa.me")) {
                                try {
                                    val waIntent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                                    waIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    ctx.startActivity(waIntent)
                                    return true
                                } catch (e: Exception) {
                                    // Fallback
                                }
                            }

                            // 4. Telephone & Mail & SMS
                            if (targetUrl.startsWith("tel:") || targetUrl.startsWith("mailto:") || targetUrl.startsWith("sms:")) {
                                try {
                                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                                    ctx.startActivity(intent)
                                    return true
                                } catch (e: Exception) {
                                    return false
                                }
                            }

                            // 5. Android Intent Scheme
                            if (targetUrl.startsWith("intent://")) {
                                try {
                                    val intent = Intent.parseUri(targetUrl, Intent.URI_INTENT_SCHEME)
                                    if (intent.resolveActivity(ctx.packageManager) != null) {
                                        ctx.startActivity(intent)
                                        return true
                                    }
                                    val fallbackUrl = intent.getStringExtra("browser_fallback_url")
                                    if (fallbackUrl != null) {
                                        view?.loadUrl(fallbackUrl)
                                        return true
                                    }
                                } catch (e: Exception) {
                                    return true
                                }
                            }

                            // 6. External Web Links -> Open in external browser
                            if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
                                try {
                                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    ctx.startActivity(intent)
                                    return true
                                } catch (e: Exception) {
                                    return false
                                }
                            }

                            return false
                        }

                        override fun onPageStarted(view: WebView?, startedUrl: String?, favicon: Bitmap?) {
                            super.onPageStarted(view, startedUrl, favicon)
                            onPageStarted()
                        }

                        override fun onPageFinished(view: WebView?, finishedUrl: String?) {
                            super.onPageFinished(view, finishedUrl)
                            onPageFinished()
                            view?.evaluateJavascript(
                                """
                                (function(){
                                    try {
                                        if (window.ZoomDzBranding && typeof window.ZoomDzBranding.sync === 'function') {
                                            window.ZoomDzBranding.sync();
                                        }
                                        fetch('/api/settings/site_images')
                                            .then(function(r){ return r.json(); })
                                            .then(function(data){
                                                if (data && typeof data === 'object' && window.ZoomDzBranding) {
                                                    try { localStorage.setItem('zoomdz_site_images', JSON.stringify(data)); } catch(e){}
                                                    window.ZoomDzBranding.apply(data);
                                                }
                                            }).catch(function(){});
                                    } catch(e){}
                                })();
                                """.trimIndent(),
                                null
                            )
                        }

                        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                            super.onReceivedError(view, request, error)
                            if (request?.isForMainFrame == true) {
                                val failingUrl = request.url.toString()
                                if (failingUrl.contains("zoomdz.com")) {
                                    view?.loadUrl(BACKUP_URL)
                                    return
                                }
                                onErrorOccurred()
                            }
                        }
                    }

                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView?, newProgress: Int) {
                            super.onProgressChanged(view, newProgress)
                            onProgressChanged(newProgress)
                        }

                        // File Chooser for Image/PDF/Homework/Certificates uploads
                        override fun onShowFileChooser(
                            webView: WebView?,
                            filePathCallback: ValueCallback<Array<Uri>>?,
                            fileChooserParams: FileChooserParams?
                        ): Boolean {
                            this@MainActivity.filePathCallback?.onReceiveValue(null)
                            this@MainActivity.filePathCallback = filePathCallback

                            val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "*/*"
                            }

                            try {
                                fileChooserLauncher.launch(intent)
                            } catch (e: Exception) {
                                this@MainActivity.filePathCallback = null
                                return false
                            }
                            return true
                        }

                        // Camera & Microphone Permission Auto-Grant for WebRTC / Agora Live Streaming
                        override fun onPermissionRequest(request: PermissionRequest?) {
                            request?.grant(request.resources)
                        }

                        // Geolocation
                        override fun onGeolocationPermissionsShowPrompt(
                            origin: String?,
                            callback: GeolocationPermissions.Callback?
                        ) {
                            callback?.invoke(origin, true, false)
                        }

                        // Fullscreen Video and Live Streams
                        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                            if (customView != null) {
                                callback?.onCustomViewHidden()
                                return
                            }
                            customView = view
                            customViewCallback = callback
                            originalOrientation = requestedOrientation
                            originalSystemUiVisibility = window.decorView.systemUiVisibility

                            (window.decorView as FrameLayout).addView(
                                view,
                                FrameLayout.LayoutParams(
                                    FrameLayout.LayoutParams.MATCH_PARENT,
                                    FrameLayout.LayoutParams.MATCH_PARENT
                                )
                            )

                            window.decorView.systemUiVisibility = (
                                View.SYSTEM_UI_FLAG_FULLSCREEN or
                                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            )
                        }

                        override fun onHideCustomView() {
                            (window.decorView as? FrameLayout)?.removeView(customView)
                            customView = null
                            customViewCallback?.onCustomViewHidden()
                            customViewCallback = null
                            window.decorView.systemUiVisibility = originalSystemUiVisibility
                            requestedOrientation = originalOrientation
                        }
                    }

                    // Native Download Manager for PDF lessons, notes, and certificates
                    setDownloadListener { downloadUrl, userAgent, contentDisposition, mimetype, contentLength ->
                        try {
                            val request = DownloadManager.Request(Uri.parse(downloadUrl))
                            request.allowScanningByMediaScanner()
                            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            request.setDestinationInExternalPublicDir(
                                Environment.DIRECTORY_DOWNLOADS,
                                Uri.parse(downloadUrl).lastPathSegment ?: "zoomdz_document.pdf"
                            )
                            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                            dm.enqueue(request)
                            Toast.makeText(ctx, "جاري تنزيل الملف وحفظه في مجلد التنزيلات...", Toast.LENGTH_SHORT).show()
                        } catch (e: Exception) {
                            val i = Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl))
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            try {
                                ctx.startActivity(i)
                            } catch (ex: Exception) {
                                Toast.makeText(ctx, "تعذر تنزيل الملف مباشرة", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }

                    val currentWebView = this
                    CookieManager.getInstance().apply {
                        setAcceptCookie(true)
                        setAcceptThirdPartyCookies(currentWebView, true)
                    }

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        databaseEnabled = true
                        allowFileAccess = true
                        allowContentAccess = true
                        loadsImagesAutomatically = true
                        blockNetworkImage = false
                        blockNetworkLoads = false
                        allowFileAccessFromFileURLs = true
                        allowUniversalAccessFromFileURLs = true
                        loadWithOverviewMode = true
                        useWideViewPort = true
                        mediaPlaybackRequiresUserGesture = false
                        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        // Admin-managed branding and uploads must always be fetched fresh.
                        cacheMode = WebSettings.LOAD_NO_CACHE
                        javaScriptCanOpenWindowsAutomatically = true
                        setSupportMultipleWindows(false)
                        setSupportZoom(true)
                        builtInZoomControls = true
                        displayZoomControls = false
                        textZoom = 100
                        userAgentString = "$userAgentString ZoomDzNativeAndroid/1.4.0"
                    }

                    // JavaScript Bridge to connect the Web App directly with Native Android features
                    addJavascriptInterface(object {
                        @JavascriptInterface
                        fun isNativeApp(): Boolean = true

                        @JavascriptInterface
                        fun getAppVersion(): String = "1.4.0"

                        @JavascriptInterface
                        fun shareText(title: String, text: String, url: String) {
                            val shareBody = if (url.isNotEmpty()) "$text\n$url" else text
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, title)
                                putExtra(Intent.EXTRA_TEXT, shareBody)
                            }
                            startActivity(Intent.createChooser(intent, "مشاركة عبر"))
                        }

                        @JavascriptInterface
                        fun copyToClipboard(text: String) {
                            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("ZoomDz", text))
                            Toast.makeText(this@MainActivity, "تم النسخ إلى الحافظة بنجاح", Toast.LENGTH_SHORT).show()
                        }

                        @JavascriptInterface
                        fun showToast(message: String) {
                            Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
                        }

                        @JavascriptInterface
                        fun vibrateDevice(ms: Long) {
                            try {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                    val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                                    vibratorManager.defaultVibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                                } else {
                                    @Suppress("DEPRECATION")
                                    val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                                    @Suppress("DEPRECATION")
                                    vibrator.vibrate(ms)
                                }
                            } catch (e: Exception) {}
                        }
                    }, "ZoomDzNative")

                    // Add a cache-busting query for the page and every admin-managed asset.
                    val freshUrl = if (url.contains("?")) "$url&native_refresh=${System.currentTimeMillis()}" else "$url?native_refresh=${System.currentTimeMillis()}"
                    loadUrl(freshUrl)

                    // Pull admin-managed branding directly inside the native WebView.
                    // This also works if a page is missing site-branding.js.
                    evaluateJavascript("""
                        (async function() {
                            try {
                                const response = await fetch('/api/settings/site_images?_native=' + Date.now(), { cache: 'no-store' });
                                if (!response.ok) return;
                                const images = await response.json();
                                const logo = images.app_logo || images.site_logo;
                                const setImage = (selector, value) => {
                                    if (!value) return;
                                    document.querySelectorAll(selector).forEach((image) => {
                                        image.src = value + (value.includes('?') ? '&' : '?') + 'native_asset=' + Date.now();
                                    });
                                };
                                const appImageUrl = (value) => value && (/^https?:\\/\\/(?:i\\.)?imgur\\.com/i.test(value) ? '/api/proxy-image?url=' + encodeURIComponent(value) : value);
  setImage('img.site-app-logo, img.brand-logo-img, img.navbar-app-logo, img.app-brand-logo, #navbarAppLogoImg, #mobileDrawerLogoImg, #studentNavAppLogo, #teacherNavAppLogo, #appPageLogoImg, #preloaderAppLogoImg', appImageUrl(logo));
                                setImage('#heroMainImage', images.hero_image);
                                setImage('#landingCard1Img', images.landing_card1_image);
                                setImage('#landingCard2Img', images.landing_card2_image);
                                setImage('.char-img-student', images.login_student_img);
                                setImage('.char-img-teacher', images.login_teacher_img);
                                setImage('.char-img-admin', images.login_admin_img);
                            } catch (_) {}
                        })();
                    """.trimIndent(), null)
                }
            },
            update = { view ->
                webView = view
            }
        )
    }

    private fun requestEssentialPermissions() {
        val permissionsToRequest = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.CAMERA)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (permissionsToRequest.isNotEmpty()) {
            requestPermissionsLauncher.launch(permissionsToRequest.toTypedArray())
        }
    }

    private fun handleBackNavigation() {
        if (customView != null) {
            (window.decorView as? FrameLayout)?.removeView(customView)
            customView = null
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            window.decorView.systemUiVisibility = originalSystemUiVisibility
            requestedOrientation = originalOrientation
            return
        }

        val currentWebView = webView
        if (currentWebView != null && currentWebView.canGoBack()) {
            currentWebView.goBack()
        } else {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastBackPressTime < 2000) {
                finish()
            } else {
                lastBackPressTime = currentTime
                Toast.makeText(this, "اضغط مرة أخرى للخروج من تطبيق ZoomDz", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.apply {
            clearCache(true)
            reload()
        }
    }

    override fun onDestroy() {
        webView?.apply {
            stopLoading()
            removeJavascriptInterface("ZoomDzNative")
            destroy()
        }
        webView = null
        super.onDestroy()
    }
}
