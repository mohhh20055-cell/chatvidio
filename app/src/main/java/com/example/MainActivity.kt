package com.example

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import com.example.ui.theme.MyApplicationTheme
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : ComponentActivity() {

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraImageUri: Uri? = null
    private var pendingFileChooserParams: WebChromeClient.FileChooserParams? = null
    private var webView: WebView? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    companion object {
        const val PLATFORM_URL = "https://zoomdz.com/"
        const val BACKUP_URL = "https://zooooooom-mown.vercel.app"
    }

    // Permission launcher for runtime permissions (Camera, Storage, Media, Audio, Notifications)
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        // Once permissions are determined, proceed with file chooser if waiting
        if (filePathCallback != null) {
            launchFileChooserIntent(pendingFileChooserParams)
        }
    }

    // File chooser launcher with robust camera + gallery handling
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        var results: Array<Uri>? = null

        if (result.resultCode == RESULT_OK) {
            val clipData = result.data?.clipData
            val dataString = result.data?.dataString

            if (clipData != null && clipData.itemCount > 0) {
                results = Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
            } else if (dataString != null) {
                results = arrayOf(Uri.parse(dataString))
            } else if (result.data?.data != null) {
                results = arrayOf(result.data!!.data!)
            } else if (cameraImageUri != null) {
                try {
                    // Check if camera captured an image
                    val file = File(cameraImageUri!!.path ?: "")
                    if (file.exists() && file.length() > 0) {
                        results = arrayOf(cameraImageUri!!)
                    } else {
                        // In case of FileProvider URI
                        results = arrayOf(cameraImageUri!!)
                    }
                } catch (e: Exception) {
                    results = arrayOf(cameraImageUri!!)
                }
            }
        }

        try {
            filePathCallback?.onReceiveValue(results)
        } catch (e: Exception) {
            // Safeguard against webview callback failures
        } finally {
            filePathCallback = null
            cameraImageUri = null
            pendingFileChooserParams = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestAppStartupPermissions()
        enableEdgeToEdge()
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.parseColor("#0B172A")
        window.navigationBarColor = Color.parseColor("#0B172A")

        setContent {
            MyApplicationTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = ComposeColor(0xFF0B172A)
                ) {
                    PlatformWebViewScreen()
                }
            }
        }
    }

    private fun getRequiredPermissions(): Array<String> {
        val permissions = mutableListOf<String>()
        permissions.add(Manifest.permission.CAMERA)
        permissions.add(Manifest.permission.RECORD_AUDIO)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
            permissions.add(Manifest.permission.READ_MEDIA_VIDEO)
            permissions.add(Manifest.permission.READ_MEDIA_AUDIO)
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        } else if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
        return permissions.toTypedArray()
    }

    private fun hasAllPermissions(): Boolean {
        return getRequiredPermissions().all { perm ->
            ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requestAppStartupPermissions() {
        val missingPermissions = getRequiredPermissions().filter { perm ->
            ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED
        }
        if (missingPermissions.isNotEmpty()) {
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }
    }

    private fun createTempCameraImageUri(): Uri? {
        return try {
            val storageDir = File(cacheDir, "camera_images").apply { if (!exists()) mkdirs() }
            val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val imageFile = File(storageDir, "IMG_${timeStamp}.jpg")
            FileProvider.getUriForFile(this, "${applicationContext.packageName}.fileprovider", imageFile)
        } catch (e: Exception) {
            null
        }
    }

    private fun launchFileChooserIntent(params: WebChromeClient.FileChooserParams?) {
        try {
            val intentList = mutableListOf<Intent>()

            // 1. Camera capture intent with FileProvider
            cameraImageUri = createTempCameraImageUri()
            if (cameraImageUri != null) {
                val takePictureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
                if (takePictureIntent.resolveActivity(packageManager) != null) {
                    intentList.add(takePictureIntent)
                }
            }

            // 2. Primary document / gallery / file picker intent
            val mimeTypes = params?.acceptTypes?.filter { it.isNotBlank() }?.toTypedArray()
            val pickIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = if (mimeTypes != null && mimeTypes.isNotEmpty()) {
                    if (mimeTypes.size == 1) mimeTypes[0] else "*/*"
                } else {
                    "*/*"
                }
                if (mimeTypes != null && mimeTypes.size > 1) {
                    putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
                }
                if (params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
            }

            val chooserIntent = Intent.createChooser(pickIntent, "اختيار ملف أو صورة").apply {
                if (intentList.isNotEmpty()) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, intentList.toTypedArray())
                }
            }

            fileChooserLauncher.launch(chooserIntent)
        } catch (e: Exception) {
            // Fallback to simple file picker if chooser crashes
            try {
                val fallbackIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                fileChooserLauncher.launch(Intent.createChooser(fallbackIntent, "اختيار ملف"))
            } catch (fallbackEx: Exception) {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = null
            }
        }
    }

    @Composable
    private fun PlatformWebViewScreen() {
        var isLoading by remember { mutableStateOf(true) }
        var hasError by remember { mutableStateOf(false) }
        var loadUrl by remember { mutableStateOf(PLATFORM_URL) }
        var progress by remember { mutableStateOf(0) }

        BackHandler { handleBack() }

        Box(modifier = Modifier.fillMaxSize()) {
            PlatformWebView(
                url = loadUrl,
                onProgress = { progress = it; if (it >= 90) isLoading = false },
                onPageStarted = { isLoading = true; hasError = false },
                onPageFinished = { isLoading = false; hasError = false },
                onError = { isLoading = false; hasError = true }
            )

            if (isLoading && progress in 1..99) {
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth().height(3.dp).align(Alignment.TopCenter),
                    color = ComposeColor(0xFF3B82F6),
                    trackColor = ComposeColor.Transparent
                )
            }

            AnimatedVisibility(visible = isLoading && progress < 40, enter = fadeIn(), exit = fadeOut()) {
                LoadingScreen()
            }

            AnimatedVisibility(visible = hasError, enter = fadeIn(), exit = fadeOut()) {
                ErrorScreen {
                    hasError = false
                    isLoading = true
                    loadUrl = if (isOnline()) PLATFORM_URL else BACKUP_URL
                    webView?.loadUrl(loadUrl)
                }
            }
        }
    }

    @Composable
    private fun LoadingScreen() {
        val transition = rememberInfiniteTransition(label = "load")
        Box(
            modifier = Modifier.fillMaxSize().background(
                Brush.verticalGradient(listOf(ComposeColor(0xFF0B172A), ComposeColor(0xFF0F172A)))
            ),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    modifier = Modifier.size(100.dp).clip(CircleShape).background(
                        Brush.linearGradient(listOf(ComposeColor(0xFF2563EB), ComposeColor(0xFF1D4ED8)))
                    ),
                    contentAlignment = Alignment.Center
                ) {
                    Text("ZoomDz", color = ComposeColor.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(28.dp))
                CircularProgressIndicator(color = ComposeColor(0xFF3B82F6), strokeWidth = 3.5.dp, modifier = Modifier.size(36.dp))
                Spacer(Modifier.height(20.dp))
                Text("منصة ZoomDz التعليمية", color = ComposeColor.White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text("جاري الاتصال بالمنصة...", color = ComposeColor(0xFF94A3B8), fontSize = 14.sp)
            }
        }
    }

    @Composable
    private fun ErrorScreen(onRetry: () -> Unit) {
        Box(
            modifier = Modifier.fillMaxSize().background(ComposeColor(0xFF0B172A)),
            contentAlignment = Alignment.Center
        ) {
            Card(
                modifier = Modifier.fillMaxWidth(0.9f).padding(16.dp),
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = ComposeColor(0xFF1E293B)),
                elevation = CardDefaults.cardElevation(8.dp)
            ) {
                Column(modifier = Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        modifier = Modifier.size(72.dp).clip(CircleShape).background(ComposeColor(0x22EF4444)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.WifiOff, "No Internet", tint = ComposeColor(0xFFEF4444), modifier = Modifier.size(36.dp))
                    }
                    Spacer(Modifier.height(20.dp))
                    Text("تعذر الاتصال بالمنصة", color = ComposeColor.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "يرجى التحقق من اتصال هاتفك بالإنترنت والمحاولة مجدداً.",
                        color = ComposeColor(0xFF94A3B8), fontSize = 14.sp, textAlign = TextAlign.Center, lineHeight = 22.sp
                    )
                    Spacer(Modifier.height(24.dp))
                    Button(
                        onClick = onRetry,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = ComposeColor(0xFF2563EB))
                    ) {
                        Icon(Icons.Default.Refresh, "Retry", tint = ComposeColor.White, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("إعادة المحاولة", color = ComposeColor.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    private fun PlatformWebView(
        url: String,
        onProgress: (Int) -> Unit,
        onPageStarted: () -> Unit,
        onPageFinished: () -> Unit,
        onError: () -> Unit
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
                    setBackgroundColor(Color.parseColor("#0B172A"))

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val targetUrl = request?.url?.toString() ?: return false
                            val host = request.url.host ?: ""
                            // Keep platform URLs inside the WebView
                            val isPlatform = host.contains("zoomdz.com") || host.contains("vercel.app") || host.contains("localhost") || targetUrl.startsWith("file://")
                            if (isPlatform) return false
                            // Open external links in browser
                            if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://") || targetUrl.contains("t.me/") || targetUrl.startsWith("tg:") || targetUrl.contains("whatsapp") || targetUrl.startsWith("wa.me")) {
                                try {
                                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                } catch (e: Exception) {}
                                return true
                            }
                            if (targetUrl.startsWith("tel:") || targetUrl.startsWith("mailto:") || targetUrl.startsWith("sms:")) {
                                try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))) } catch (e: Exception) {}
                                return true
                            }
                            return false
                        }

                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            onPageStarted()
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            onPageFinished()
                        }

                        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                            super.onReceivedError(view, request, error)
                            if (request?.isForMainFrame == true) {
                                val failUrl = request.url.toString()
                                if (failUrl.contains("zoomdz.com")) {
                                    view?.loadUrl(BACKUP_URL)
                                    return
                                }
                                onError()
                            }
                        }
                    }

                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView?, newProgress: Int) {
                            super.onProgressChanged(view, newProgress)
                            onProgress(newProgress)
                        }

                        override fun onShowFileChooser(wv: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                            // Cancel any prior dangling callback to prevent WebView locking
                            filePathCallback?.onReceiveValue(null)
                            filePathCallback = callback
                            pendingFileChooserParams = params

                            if (!hasAllPermissions()) {
                                // Request permissions first, then proceed
                                val missing = getRequiredPermissions().filter {
                                    ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED
                                }
                                if (missing.isNotEmpty()) {
                                    permissionLauncher.launch(missing.toTypedArray())
                                    return true
                                }
                            }

                            launchFileChooserIntent(params)
                            return true
                        }

                        override fun onPermissionRequest(request: PermissionRequest?) {
                            if (request == null) return
                            val missing = mutableListOf<String>()
                            for (res in request.resources) {
                                if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE) {
                                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                                        missing.add(Manifest.permission.CAMERA)
                                    }
                                }
                                if (res == PermissionRequest.RESOURCE_AUDIO_CAPTURE) {
                                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                        missing.add(Manifest.permission.RECORD_AUDIO)
                                    }
                                }
                            }
                            if (missing.isNotEmpty()) {
                                permissionLauncher.launch(missing.toTypedArray())
                            }
                            request.grant(request.resources)
                        }

                        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                            callback?.invoke(origin, true, false)
                        }

                        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                            if (customView != null) { callback?.onCustomViewHidden(); return }
                            customView = view
                            customViewCallback = callback
                            (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
                            ))
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
                            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
                        }
                    }

                    val wv = this
                    CookieManager.getInstance().apply {
                        setAcceptCookie(true)
                        setAcceptThirdPartyCookies(wv, true)
                    }

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        databaseEnabled = true
                        allowFileAccess = true
                        allowContentAccess = true
                        loadsImagesAutomatically = true
                        loadWithOverviewMode = true
                        useWideViewPort = true
                        mediaPlaybackRequiresUserGesture = false
                        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        cacheMode = WebSettings.LOAD_DEFAULT
                        javaScriptCanOpenWindowsAutomatically = true
                        setSupportZoom(true)
                        builtInZoomControls = true
                        displayZoomControls = false
                        textZoom = 100
                        userAgentString = "$userAgentString ZoomDzNativeAndroid/2.1.0"
                    }

                    addJavascriptInterface(object {
                        @JavascriptInterface fun isNativeApp() = true
                        @JavascriptInterface fun getAppVersion() = "2.1.0"
                        @JavascriptInterface fun showToast(msg: String) {
                            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
                        }
                        @JavascriptInterface fun shareText(title: String, text: String, url: String) {
                            val body = if (url.isNotEmpty()) "$text\n$url" else text
                            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, title)
                                putExtra(Intent.EXTRA_TEXT, body)
                            }, "مشاركة عبر"))
                        }
                    }, "ZoomDzNative")

                    loadUrl(url)
                }
            },
            update = { view ->
                webView = view
                if (view.url.isNullOrBlank() || view.url == "about:blank") {
                    view.loadUrl(PLATFORM_URL)
                }
            }
        )
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun handleBack() {
        if (customView != null) {
            (window.decorView as? FrameLayout)?.removeView(customView)
            customView = null
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
            return
        }
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView?.restoreState(savedInstanceState)
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        webView?.apply {
            stopLoading()
            removeJavascriptInterface("ZoomDzNative")
            destroy()
        }
        webView = null
        super.onDestroy()
    }
}
