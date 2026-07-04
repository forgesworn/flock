// flock — offline BLE mesh transport (dual-role peripheral + central), forked
// from meatchat's plugin then evolved for flock's two-mode design.
//
// flock computes and passes its OWN serviceUuid at start() time — never hardcoded,
// it stays a runtime parameter end to end (advertise filter, scan filter, GATT
// service). In DISCREET mode that is a rotating per-window members-only UUID; in
// CROWD/MESH mode it is the common daily UUID (see app/src/bleId.ts).
//
// Two things distinguish this from the spike (Slice 2):
//   1. BIDIRECTIONAL SINGLE LINK. The frame characteristic is write-only
//      (client→server); a NOTIFY characteristic carries the reverse (server→
//      client). So one physical GATT connection now moves data BOTH ways, which
//      lets us re-enable role ARBITRATION: of any two peers, only the one with the
//      higher advertised tiebreak initiates the connection (the other serves +
//      notifies). One link per pair, not two — essential because BLE caps at ~7
//      connections and a crowd needs the budget.
//   2. FLOOD/RELAY. The envelope carries a hop count (`h`); in mesh mode an
//      unseen frame is re-broadcast to every OTHER peer with h-1, so a wrap
//      reaches past directly-connected peers. Dedup by envelope id stops loops.
//
// Injected by native/patch-android.mjs; registered in MainActivity.
package cc.trotters.flock;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "FlockBle",
    permissions = {
        @Permission(
            alias = FlockBlePlugin.BLE_MODERN_PERMISSION_ALIAS,
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(alias = FlockBlePlugin.BLE_LEGACY_PERMISSION_ALIAS, strings = { Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class FlockBlePlugin extends Plugin {
    static final String BLE_MODERN_PERMISSION_ALIAS = "bleModern";
    static final String BLE_LEGACY_PERMISSION_ALIAS = "bleLegacy";

    private static final String EVENT_FRAME = "frame";
    private static final String EVENT_STATUS = "status";
    private static final String BROADCAST = "*";
    // Frame characteristic: client → server (WRITE). Inbox characteristic: server →
    // client (NOTIFY) — the reverse direction that makes a single arbitrated link
    // bidirectional. CCCD is the standard Client Characteristic Configuration
    // Descriptor a client writes to subscribe to notifications.
    private static final UUID FRAME_CHARACTERISTIC_UUID = UUID.fromString("29b8d9f3-2c2b-4ed1-a12c-7401e5b7b37f");
    private static final UUID INBOX_CHARACTERISTIC_UUID = UUID.fromString("29b8d9f3-2c2b-4ed1-a12c-7401e5b7b380");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final byte CHUNK_MAGIC = 0x4d;
    private static final byte CHUNK_VERSION = 0x01;
    private static final int CHUNK_HEADER_BYTES = 8;
    private static final int REQUESTED_MTU = 247;
    private static final int MAX_CHUNK_PAYLOAD = 160;
    private static final int MAX_CHUNKS = 255;
    private static final int MAX_ENVELOPE_BYTES = 8192;
    private static final int MAX_SEEN_IDS = 512;
    private static final long REASSEMBLY_TTL_MS = 30_000L;
    private static final int MAX_SERVICE_DISCOVERY_ATTEMPTS = 4;
    private static final String TAG = "FlockBle";
    private static final int MANUF_ID = 0xFFFF; // advert manufacturer-data id for our tiebreak
    private static final long CONNECT_COOLDOWN_MS = 4000L; // per-address reconnect backoff
    private static final long CONNECT_THROTTLE_MS = 1500L; // global: ≤1 new connection per window
    private static final int MAX_CLIENT_LINKS = 3; // cap client-initiated links (peers rotate BLE addresses)
    private static final int TIEBREAK_BYTES = 4;
    private static final int MAX_HOPS = 8; // clamp the mesh hop budget (loop/storm backstop)

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, Link> links = new ConcurrentHashMap<>();           // links WE initiated (client role)
    private final Map<String, ServerLink> serverLinks = new ConcurrentHashMap<>(); // peers that connected to US (server role)
    private final Map<String, Reassembly> inbound = new ConcurrentHashMap<>();
    private final Map<String, String> peerAddresses = new ConcurrentHashMap<>();
    private final LinkedHashMap<String, Boolean> seenIds = new LinkedHashMap<>();
    // Per-session random tiebreak: on discovery, only the HIGHER tiebreak initiates
    // the GATT connection; the lower yields to its GATT server. Kills the dual-role
    // "both connect" glare that caused "out of resources" churn. Advertised in
    // manufacturer data so a scanner reads it before deciding to connect.
    private byte[] tiebreak;
    private final Map<String, Long> lastAttempt = new ConcurrentHashMap<>(); // address → last connect attempt (backoff)
    private long lastConnectAt = 0L; // global connect throttle (peers rotate addresses)

    private BluetoothManager bluetoothManager;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic inboxCharacteristic; // server→client NOTIFY channel

    private UUID serviceUuid;
    private byte[] roomHash = new byte[0];
    private String room;
    private String selfId;
    // Initial hop budget stamped on our own frames. 0 = discreet (single-hop, no
    // relay). >0 = crowd mesh: an unseen frame is re-broadcast with h-1 until it
    // hits 0, so a wrap reaches peers we are not directly connected to.
    private int initialHops = 0;
    private boolean running = false;
    private boolean advertisingActive = false;
    private boolean scanningActive = false;
    private boolean retriedCompactAdvertisement = false;
    private long txFrames = 0;
    private long txChunks = 0;
    private long rxFrames = 0;
    private long rxChunks = 0;
    private long droppedFrames = 0;
    private String lastError;

    @PluginMethod
    public void start(PluginCall call) {
        String nextRoom = call.getString("room");
        String nextSelfId = call.getString("selfId");
        String nextServiceUuid = call.getString("serviceUuid");
        if (isBlank(nextRoom) || isBlank(nextSelfId) || isBlank(nextServiceUuid)) {
            call.reject("room, selfId and serviceUuid are required");
            return;
        }

        try {
            UUID.fromString(nextServiceUuid);
        } catch (IllegalArgumentException e) {
            call.reject("serviceUuid must be a valid UUID", "BAD_ARGS", e);
            return;
        }

        if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            rememberError("this device does not support Bluetooth LE");
            call.reject("this device does not support Bluetooth LE", "UNAVAILABLE");
            return;
        }

        List<String> missing = missingRuntimePermissions();
        if (!missing.isEmpty()) {
            lastError = "Bluetooth permissions are required";
            emitStatus();
            requestPermissionForAlias(requiredPermissionAlias(), call, "blePermissionCallback");
            return;
        }

        beginStart(call);
    }

    @PermissionCallback
    private void blePermissionCallback(PluginCall call) {
        if (call == null) return;

        List<String> missing = missingRuntimePermissions();
        if (!missing.isEmpty()) {
            rememberError("Bluetooth permissions were denied");
            call.reject("Bluetooth permissions were denied", "PERMISSION_DENIED");
            return;
        }

        beginStart(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRadio();
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        sendFrame(call, BROADCAST);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String peer = call.getString("peer");
        if (isBlank(peer)) {
            call.reject("peer is required");
            return;
        }
        sendFrame(call, peer);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    @Override
    protected void handleOnDestroy() {
        stopRadio();
        super.handleOnDestroy();
    }

    private JSObject buildStatus() {
        List<String> missingPermissions = missingRuntimePermissions();
        JSObject status = new JSObject();
        status.put("native", true);
        status.put("platform", "android");
        status.put("supported", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE));
        status.put("running", running);
        status.put("bluetooth", bluetoothState());
        status.put("permissions", missingPermissions.isEmpty() ? "granted" : "missing");
        status.put("missingPermissions", stringArray(missingPermissions));
        status.put("room", room == null ? JSONObject.NULL : room);
        status.put("selfId", selfId == null ? JSONObject.NULL : selfId);
        status.put("serviceUuid", serviceUuid == null ? JSONObject.NULL : serviceUuid.toString());
        status.put("advertising", advertisingActive);
        status.put("scanning", scanningActive);
        status.put("gattServer", gattServer != null);

        int writablePeers = 0;
        int queuedChunks = 0;
        JSONArray peers = new JSONArray();
        for (Link link : links.values()) {
            int linkQueued;
            boolean linkWriting;
            synchronized (link) {
                linkQueued = link.queue.size();
                linkWriting = link.writing;
            }
            queuedChunks += linkQueued;
            if (linkWriting) queuedChunks += 1;
            if (link.characteristic != null) writablePeers += 1;

            JSObject peer = new JSObject();
            peer.put("address", link.address);
            peer.put("peerIds", peerIdsFor(link.address));
            peer.put("connected", link.gatt != null);
            peer.put("writable", link.characteristic != null);
            peer.put("mtu", link.mtu);
            peer.put("queuedChunks", linkQueued);
            peer.put("writing", linkWriting);
            peers.put(peer);
        }

        int subscribedServerLinks = 0;
        for (ServerLink server : serverLinks.values()) if (server.subscribed) subscribedServerLinks += 1;

        status.put("connectedPeers", links.size());
        status.put("writablePeers", writablePeers);
        status.put("serverLinks", serverLinks.size());
        status.put("notifiablePeers", subscribedServerLinks);
        status.put("hops", initialHops);
        status.put("knownPeers", peerAddresses.size());
        status.put("queuedChunks", queuedChunks);
        status.put("txFrames", txFrames);
        status.put("txChunks", txChunks);
        status.put("rxFrames", rxFrames);
        status.put("rxChunks", rxChunks);
        status.put("droppedFrames", droppedFrames);
        status.put("lastError", lastError == null ? JSONObject.NULL : lastError);
        status.put("peers", peers);
        status.put("updatedAt", System.currentTimeMillis());
        return status;
    }

    private JSONArray stringArray(List<String> values) {
        JSONArray array = new JSONArray();
        for (String value : values) array.put(value);
        return array;
    }

    private JSONArray peerIdsFor(String address) {
        JSONArray ids = new JSONArray();
        for (Map.Entry<String, String> entry : peerAddresses.entrySet()) {
            if (address.equals(entry.getValue())) ids.put(entry.getKey());
        }
        return ids;
    }

    private String bluetoothState() {
        BluetoothManager manager = bluetoothManager;
        if (manager == null) manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bluetoothAdapter;
        if (adapter == null && manager != null) adapter = manager.getAdapter();
        if (adapter == null) return "unavailable";
        return adapter.isEnabled() ? "on" : "off";
    }

    private void emitStatus() {
        JSObject status = buildStatus();
        mainHandler.post(() -> notifyListeners(EVENT_STATUS, status));
    }

    private void rememberError(String message) {
        lastError = message;
        emitStatus();
    }

    private void dropInboundFrame() {
        droppedFrames += 1;
        emitStatus();
    }

    private void beginStart(PluginCall call) {
        String nextRoom = call.getString("room");
        String nextSelfId = call.getString("selfId");
        String nextServiceUuid = call.getString("serviceUuid");
        if (isBlank(nextRoom) || isBlank(nextSelfId) || isBlank(nextServiceUuid)) {
            call.reject("room, selfId and serviceUuid are required");
            return;
        }

        stopRadio();

        bluetoothManager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null) {
            rememberError("Bluetooth manager is unavailable");
            call.reject("Bluetooth manager is unavailable", "UNAVAILABLE");
            return;
        }

        bluetoothAdapter = bluetoothManager.getAdapter();
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            rememberError("Bluetooth is off or unavailable");
            call.reject("Bluetooth is off or unavailable", "UNAVAILABLE");
            return;
        }

        serviceUuid = UUID.fromString(nextServiceUuid);
        tiebreak = new byte[TIEBREAK_BYTES];
        new SecureRandom().nextBytes(tiebreak);
        room = nextRoom;
        selfId = nextSelfId;
        // `hops` selects the mode: 0 (default) = discreet single-hop; >0 = crowd mesh
        // flood/relay. Clamped so a hostile/oversized value can't create a storm.
        initialHops = Math.max(0, Math.min(MAX_HOPS, call.getInt("hops", 0)));
        roomHash = roomHash(nextRoom);
        Log.d(TAG, "start uuid=" + nextServiceUuid + " hops=" + initialHops + " tiebreak=" + hex(tiebreak));
        txFrames = 0;
        txChunks = 0;
        rxFrames = 0;
        rxChunks = 0;
        droppedFrames = 0;
        lastError = null;

        if (!startGattServer()) {
            stopRadio();
            rememberError("could not start BLE GATT server");
            call.reject("could not start BLE GATT server", "UNAVAILABLE");
            return;
        }

        running = true;
        emitStatus();
        startAdvertising();
        startScanning();
        call.resolve();
        emitStatus();
    }

    @SuppressLint("MissingPermission")
    private boolean startGattServer() {
        if (bluetoothManager == null || serviceUuid == null) return false;
        gattServer = bluetoothManager.openGattServer(getContext(), serverCallback);
        if (gattServer == null) return false;

        BluetoothGattService service = new BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        // Client → server: the peer who initiated the link WRITEs frames here.
        BluetoothGattCharacteristic frameCharacteristic = new BluetoothGattCharacteristic(
            FRAME_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        );
        service.addCharacteristic(frameCharacteristic);
        // Server → client: we NOTIFY frames back over the SAME link, so the peer
        // that connected to us never needs to open a second connection. This is the
        // reverse channel that makes role arbitration (one link per pair) safe.
        BluetoothGattCharacteristic inbox = new BluetoothGattCharacteristic(
            INBOX_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ
        );
        BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
        );
        inbox.addDescriptor(cccd);
        service.addCharacteristic(inbox);
        inboxCharacteristic = inbox;
        return gattServer.addService(service);
    }

    @SuppressLint("MissingPermission")
    private void startAdvertising() {
        if (bluetoothAdapter == null || serviceUuid == null) return;
        advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            rememberError("BLE advertiser is unavailable");
            return;
        }
        advertisingActive = false;
        retriedCompactAdvertisement = false;
        try {
            advertiser.startAdvertising(advertiseSettings(), advertiseData(), scanResponseData(), advertiseCallback);
            emitStatus();
        } catch (RuntimeException e) {
            rememberError("could not start BLE advertising: " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    private void startCompactAdvertising() {
        if (advertiser == null) return;
        retriedCompactAdvertisement = true;
        advertisingActive = false;
        try {
            advertiser.startAdvertising(advertiseSettings(), advertiseData(), advertiseCallback);
            emitStatus();
        } catch (RuntimeException e) {
            rememberError("could not start compact BLE advertising: " + e.getMessage());
        }
    }

    private AdvertiseSettings advertiseSettings() {
        return new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build();
    }

    private AdvertiseData advertiseData() {
        // 128-bit service UUID (18 B) + our 4-byte tiebreak as manufacturer data
        // (8 B) + flags (3 B) = 29 B, within the 31 B legacy-advert budget. The
        // tiebreak rides the MAIN advert (not the scan response) so a scanner has
        // it before connecting, and it survives the compact-advert fallback.
        AdvertiseData.Builder b = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(new ParcelUuid(serviceUuid));
        if (tiebreak != null) b.addManufacturerData(MANUF_ID, tiebreak);
        return b.build();
    }

    private AdvertiseData scanResponseData() {
        return new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(new ParcelUuid(serviceUuid), roomHash)
            .build();
    }

    @SuppressLint("MissingPermission")
    private void startScanning() {
        if (bluetoothAdapter == null || serviceUuid == null) return;
        scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            rememberError("BLE scanner is unavailable");
            return;
        }

        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(serviceUuid)).build();
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
        try {
            scanner.startScan(Collections.singletonList(filter), settings, scanCallback);
            scanningActive = true;
            emitStatus();
        } catch (RuntimeException e) {
            scanningActive = false;
            rememberError("could not start BLE scan: " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    private void stopRadio() {
        running = false;
        advertisingActive = false;
        scanningActive = false;

        if (scanner != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (RuntimeException ignored) {
                // Total teardown: Android can throw if Bluetooth vanished mid-stop.
            }
            scanner = null;
        }

        if (advertiser != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (RuntimeException ignored) {
                // Total teardown.
            }
            advertiser = null;
        }

        for (Link link : links.values()) {
            try {
                link.close();
            } catch (RuntimeException ignored) {
                // Total teardown.
            }
        }
        links.clear();
        serverLinks.clear();

        if (gattServer != null) {
            try {
                gattServer.close();
            } catch (RuntimeException ignored) {
                // Total teardown.
            }
            gattServer = null;
        }
        inboxCharacteristic = null;

        inbound.clear();
        peerAddresses.clear();
        lastAttempt.clear();
        tiebreak = null;
        initialHops = 0;
        synchronized (seenIds) {
            seenIds.clear();
        }
        serviceUuid = null;
        roomHash = new byte[0];
        room = null;
        selfId = null;
        emitStatus();
    }

    @SuppressLint("MissingPermission")
    private void connect(BluetoothDevice device) {
        if (!running || device == null) return;
        String address = device.getAddress();
        if (isBlank(address) || links.containsKey(address)) return;
        // Reconnect backoff: after a drop the scan re-fires connect() immediately;
        // a cooldown per address stops a churn storm (and glare-induced flapping).
        long now = SystemClock.uptimeMillis();
        Long last = lastAttempt.get(address);
        if (last != null && now - last < CONNECT_COOLDOWN_MS) return;
        // A peer's BLE advertising address rotates (privacy), so per-address backoff
        // alone can't stop a storm of "new" addresses that are really one device.
        // Cap concurrent client links and globally throttle new attempts.
        if (links.size() >= MAX_CLIENT_LINKS) return;
        if (now - lastConnectAt < CONNECT_THROTTLE_MS) return;
        lastConnectAt = now;
        lastAttempt.put(address, now);

        Log.d(TAG, "connect -> " + tail(address));
        Link link = new Link(address);
        links.put(address, link);
        BluetoothGatt gatt = device.connectGatt(getContext(), false, clientCallback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) {
            links.remove(address);
            rememberError("could not connect to discovered BLE peer");
            return;
        }
        link.gatt = gatt;
        emitStatus();
    }

    private void sendFrame(PluginCall call, String target) {
        if (!running) {
            rememberError("native BLE transport is not running");
            call.reject("native BLE transport is not running", "UNAVAILABLE");
            return;
        }

        String data = call.getString("data");
        if (isBlank(data)) {
            rememberError("BLE frame data is required");
            call.reject("data is required");
            return;
        }

        byte[] envelope;
        try {
            envelope = buildEnvelope(target, data).getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) {
            rememberError("could not encode BLE envelope");
            call.reject("could not encode BLE envelope", "BAD_FRAME", e);
            return;
        }

        if (envelope.length > MAX_ENVELOPE_BYTES) {
            rememberError("BLE frame is too large");
            call.reject("BLE frame is too large", "BAD_FRAME");
            return;
        }

        int queued = broadcastEnvelope(envelope, null);
        txFrames += 1;
        JSObject result = new JSObject();
        result.put("queuedPeers", queued);
        call.resolve(result);
        emitStatus();
    }

    private String buildEnvelope(String target, String data) throws JSONException {
        JSONObject envelope = new JSONObject();
        envelope.put("v", 1);
        envelope.put("r", room);
        envelope.put("t", target);
        envelope.put("f", selfId);
        envelope.put("id", UUID.randomUUID().toString());
        envelope.put("h", initialHops);
        envelope.put("d", data);
        return envelope.toString();
    }

    /** Send an already-serialised envelope to every reachable peer — both links we
     *  initiated (client WRITE) and peers that connected to us (server NOTIFY) —
     *  except `excludeAddress` (the immediate hop a relayed frame came from, so it
     *  is never echoed straight back). flock addresses inside the opaque wrap, so
     *  the BLE layer always floods; the wire `t` field is kept only for the self /
     *  broadcast checks on receive. Returns the number of peers enqueued to. */
    private int broadcastEnvelope(byte[] envelope, String excludeAddress) {
        int queued = 0;
        for (Link link : links.values()) {
            if (link.characteristic == null) continue; // not yet ready to write
            if (excludeAddress != null && excludeAddress.equals(link.address)) continue;
            List<byte[]> chunks = chunksFor(link.mtu, envelope);
            if (chunks.isEmpty()) continue;
            txChunks += chunks.size();
            enqueue(link, chunks);
            queued += 1;
        }
        for (ServerLink server : serverLinks.values()) {
            if (!server.subscribed) continue; // client hasn't enabled notifications yet
            if (excludeAddress != null && excludeAddress.equals(server.address)) continue;
            List<byte[]> chunks = chunksFor(server.mtu, envelope);
            if (chunks.isEmpty()) continue;
            txChunks += chunks.size();
            enqueueServer(server, chunks);
            queued += 1;
        }
        return queued;
    }

    private List<byte[]> chunksFor(int mtu, byte[] envelope) {
        int payloadBytes = Math.max(1, Math.min(MAX_CHUNK_PAYLOAD, mtu - CHUNK_HEADER_BYTES));
        int total = Math.max(1, (envelope.length + payloadBytes - 1) / payloadBytes);
        if (total > MAX_CHUNKS) return Collections.emptyList();

        int messageId = (int) (System.nanoTime() ^ UUID.randomUUID().getLeastSignificantBits());
        List<byte[]> chunks = new ArrayList<>(total);
        for (int index = 0; index < total; index++) {
            int from = index * payloadBytes;
            int to = Math.min(envelope.length, from + payloadBytes);
            int len = to - from;
            byte[] chunk = new byte[CHUNK_HEADER_BYTES + len];
            chunk[0] = CHUNK_MAGIC;
            chunk[1] = CHUNK_VERSION;
            chunk[2] = (byte) ((messageId >>> 24) & 0xff);
            chunk[3] = (byte) ((messageId >>> 16) & 0xff);
            chunk[4] = (byte) ((messageId >>> 8) & 0xff);
            chunk[5] = (byte) (messageId & 0xff);
            chunk[6] = (byte) index;
            chunk[7] = (byte) total;
            System.arraycopy(envelope, from, chunk, CHUNK_HEADER_BYTES, len);
            chunks.add(chunk);
        }
        return chunks;
    }

    private void enqueue(Link link, List<byte[]> chunks) {
        if (chunks.isEmpty()) return;
        synchronized (link) {
            link.queue.addAll(chunks);
        }
        mainHandler.post(() -> flush(link));
        emitStatus();
    }

    private void enqueueServer(ServerLink server, List<byte[]> chunks) {
        if (chunks.isEmpty()) return;
        synchronized (server) {
            server.queue.addAll(chunks);
        }
        mainHandler.post(() -> flushServer(server));
        emitStatus();
    }

    /** Push the next queued chunk to a peer that connected to US, over the NOTIFY
     *  characteristic. Flow-controlled by onNotificationSent (one in flight), so it
     *  mirrors the client-side flush() write loop. */
    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private void flushServer(ServerLink server) {
        if (!running || gattServer == null || inboxCharacteristic == null || !server.subscribed || server.writing) return;

        byte[] next;
        synchronized (server) {
            next = server.queue.poll();
            if (next == null) return;
            server.writing = true;
        }

        boolean accepted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            accepted = gattServer.notifyCharacteristicChanged(server.device, inboxCharacteristic, false, next)
                == BluetoothStatusCodes.SUCCESS;
        } else {
            inboxCharacteristic.setValue(next);
            accepted = gattServer.notifyCharacteristicChanged(server.device, inboxCharacteristic, false);
        }

        if (!accepted) {
            synchronized (server) {
                server.writing = false;
            }
            rememberError("BLE notification was not accepted");
            closeServerLink(server.address);
        }
        emitStatus();
    }

    @SuppressLint("MissingPermission")
    private void requestServiceDiscovery(BluetoothGatt gatt, Link link) {
        if (gatt == null || link == null || link.servicesRequested) return;
        if (link.serviceDiscoveryAttempts >= MAX_SERVICE_DISCOVERY_ATTEMPTS) {
            rememberError("BLE service discovery did not complete");
            closeLink(link.address);
            return;
        }
        link.servicesRequested = true;
        link.serviceDiscoveryAttempts += 1;
        if (!gatt.discoverServices()) {
            link.servicesRequested = false;
            rememberError("BLE service discovery was not accepted");
            closeLink(link.address);
            return;
        }
        mainHandler.postDelayed(() -> {
            Link current = links.get(link.address);
            if (current == link && current.characteristic == null) {
                current.servicesRequested = false;
                requestServiceDiscovery(gatt, current);
                emitStatus();
            }
        }, 2500);
    }

    private void retryServiceDiscovery(BluetoothGatt gatt, Link link) {
        if (link == null) return;
        link.servicesRequested = false;
        mainHandler.postDelayed(() -> {
            Link current = links.get(link.address);
            if (current == link && current.characteristic == null) {
                requestServiceDiscovery(gatt, current);
                emitStatus();
            }
        }, 750);
    }

    /** Enable notifications on the peer's INBOX characteristic — the reverse channel
     *  that carries their replies back over this one link. Writes the standard CCCD
     *  ENABLE_NOTIFICATION_VALUE; the peer's onDescriptorWriteRequest then marks us
     *  subscribed and starts notifying. Best-effort — a missing inbox/CCCD (older
     *  peer) just leaves this link write-only, which still works. */
    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private void subscribeInbox(BluetoothGatt gatt, BluetoothGattService service) {
        if (gatt == null || service == null) return;
        BluetoothGattCharacteristic inbox = service.getCharacteristic(INBOX_CHARACTERISTIC_UUID);
        if (inbox == null) return;
        try {
            gatt.setCharacteristicNotification(inbox, true);
            BluetoothGattDescriptor cccd = inbox.getDescriptor(CCCD_UUID);
            if (cccd == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            } else {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                gatt.writeDescriptor(cccd);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "subscribeInbox failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private void flush(Link link) {
        if (!running || link.gatt == null || link.characteristic == null || link.writing) return;

        byte[] next;
        synchronized (link) {
            next = link.queue.poll();
            if (next == null) return;
            link.writing = true;
        }

        link.characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        boolean accepted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            accepted = link.gatt.writeCharacteristic(
                link.characteristic,
                next,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            ) == BluetoothStatusCodes.SUCCESS;
        } else {
            link.characteristic.setValue(next);
            accepted = link.gatt.writeCharacteristic(link.characteristic);
        }

        if (!accepted) {
            synchronized (link) {
                link.writing = false;
            }
            rememberError("BLE characteristic write was not accepted");
            closeLink(link.address);
        }
        emitStatus();
    }

    private void handleChunk(String source, byte[] chunk) {
        if (isBlank(source) || chunk == null || chunk.length < CHUNK_HEADER_BYTES) {
            dropInboundFrame();
            return;
        }
        if (chunk[0] != CHUNK_MAGIC || chunk[1] != CHUNK_VERSION) {
            dropInboundFrame();
            return;
        }
        rxChunks += 1;

        int messageId = ((chunk[2] & 0xff) << 24) | ((chunk[3] & 0xff) << 16) | ((chunk[4] & 0xff) << 8) | (chunk[5] & 0xff);
        int index = chunk[6] & 0xff;
        int total = chunk[7] & 0xff;
        if (total < 1 || index >= total) {
            dropInboundFrame();
            return;
        }

        pruneReassembly();

        String key = source + ":" + messageId;
        Reassembly reassembly = inbound.computeIfAbsent(key, ignored -> new Reassembly(total));
        if (reassembly.total != total) {
            inbound.remove(key);
            dropInboundFrame();
            return;
        }

        byte[] payload = Arrays.copyOfRange(chunk, CHUNK_HEADER_BYTES, chunk.length);
        if (!reassembly.add(index, payload)) {
            inbound.remove(key);
            dropInboundFrame();
            return;
        }

        if (!reassembly.isComplete()) {
            emitStatus();
            return;
        }

        inbound.remove(key);
        byte[] envelope = reassembly.join();
        if (envelope.length <= MAX_ENVELOPE_BYTES) {
            handleEnvelope(source, envelope);
        } else {
            dropInboundFrame();
        }
        emitStatus();
    }

    private void handleEnvelope(String source, byte[] envelopeBytes) {
        try {
            JSONObject envelope = new JSONObject(new String(envelopeBytes, StandardCharsets.UTF_8));
            if (envelope.optInt("v", 0) != 1) {
                dropInboundFrame();
                return;
            }
            String envelopeRoom = envelope.optString("r", null);
            String from = envelope.optString("f", null);
            String target = envelope.optString("t", null);
            String id = envelope.optString("id", null);
            String data = envelope.optString("d", null);
            int hops = envelope.optInt("h", 0);

            if (room == null || !room.equals(envelopeRoom)) {
                dropInboundFrame();
                return;
            }
            if (isBlank(from) || from.equals(selfId)) {
                dropInboundFrame();
                return;
            }
            if (isBlank(target) || (!BROADCAST.equals(target) && !selfId.equals(target))) {
                dropInboundFrame();
                return;
            }
            if (isBlank(id) || isBlank(data)) {
                dropInboundFrame();
                return;
            }
            if (!rememberSeen(id)) {
                dropInboundFrame();
                return;
            }

            peerAddresses.put(from, source);
            rxFrames += 1;
            Log.d(TAG, "rx frame from " + tail(source) + " (" + data.length() + "B, h=" + hops + ")");
            JSObject event = new JSObject();
            event.put("from", from);
            event.put("data", data);
            mainHandler.post(() -> notifyListeners(EVENT_FRAME, event));
            // Crowd mesh: blindly relay an unseen frame onward with one fewer hop, to
            // every peer EXCEPT the one it came from. dedup (rememberSeen) above means
            // each frame is relayed at most once here, so this cannot loop. We relay
            // even frames we cannot decrypt — the payload is opaque; a relayer can't
            // read what it forwards. No-op in discreet mode (initialHops == 0).
            if (initialHops > 0 && hops > 0) relayEnvelope(source, envelopeRoom, target, from, id, data, hops - 1);
            emitStatus();
        } catch (JSONException ignored) {
            // Hostile or stale BLE payloads are dropped silently.
            dropInboundFrame();
        }
    }

    /** Re-broadcast a received frame one hop further out (crowd mesh flood). Keeps
     *  the original id (so downstream dedup works) and origin `f`, only decrementing
     *  the hop count; excludes the immediate source so it is never echoed back. */
    private void relayEnvelope(String source, String envRoom, String target, String from, String id, String data, int hops) {
        try {
            JSONObject relay = new JSONObject();
            relay.put("v", 1);
            relay.put("r", envRoom);
            relay.put("t", target);
            relay.put("f", from);
            relay.put("id", id);
            relay.put("h", hops);
            relay.put("d", data);
            byte[] bytes = relay.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length <= MAX_ENVELOPE_BYTES) broadcastEnvelope(bytes, source);
        } catch (JSONException ignored) {
            // Should never happen (we just parsed these fields); drop if it does.
        }
    }

    private boolean rememberSeen(String id) {
        synchronized (seenIds) {
            if (seenIds.containsKey(id)) return false;
            seenIds.put(id, Boolean.TRUE);
            while (seenIds.size() > MAX_SEEN_IDS) {
                Iterator<String> it = seenIds.keySet().iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
            }
            return true;
        }
    }

    private void pruneReassembly() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, Reassembly> entry : inbound.entrySet()) {
            if (now - entry.getValue().createdAt > REASSEMBLY_TTL_MS) {
                inbound.remove(entry.getKey());
            }
        }
    }

    @SuppressLint("MissingPermission")
    private void closeLink(String address) {
        Link link = links.remove(address);
        if (link == null) return;
        link.close();
        peerAddresses.values().removeAll(Collections.singleton(address));
        emitStatus();
    }

    /** Forget a peer that had connected to our GATT server (they dropped, or their
     *  notify failed). The connection itself is owned by the OS GATT server; we only
     *  drop our outbound bookkeeping for it. */
    private void closeServerLink(String address) {
        ServerLink server = serverLinks.remove(address);
        if (server == null) return;
        synchronized (server) {
            server.queue.clear();
            server.writing = false;
            server.subscribed = false;
        }
        peerAddresses.values().removeAll(Collections.singleton(address));
        emitStatus();
    }

    private List<String> missingRuntimePermissions() {
        List<String> permissions = requiredRuntimePermissions();
        List<String> missing = new ArrayList<>();
        for (String permission : permissions) {
            if (ActivityCompat.checkSelfPermission(getContext(), permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        return missing;
    }

    private List<String> requiredRuntimePermissions() {
        List<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_SCAN);
            permissions.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        return permissions;
    }

    private String requiredPermissionAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? BLE_MODERN_PERMISSION_ALIAS : BLE_LEGACY_PERMISSION_ALIAS;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    /** Unsigned lexicographic byte compare — the connection-role tiebreak. */
    private static int compareUnsigned(byte[] a, byte[] b) {
        int n = Math.min(a.length, b.length);
        for (int i = 0; i < n; i++) {
            int x = a[i] & 0xff, y = b[i] & 0xff;
            if (x != y) return x < y ? -1 : 1;
        }
        return Integer.compare(a.length, b.length);
    }

    /** Arbitration: do WE initiate the connection to a peer with this advertised
     *  tiebreak? Yes if ours is higher (or equal — a rare tie, both connect), or if
     *  we can't read theirs (connect rather than risk nobody connecting). The peer
     *  runs the mirror test, so exactly one side initiates when both reads succeed. */
    private boolean shouldInitiate(byte[] peerTiebreak) {
        if (tiebreak == null || peerTiebreak == null || peerTiebreak.length == 0) return true;
        return compareUnsigned(tiebreak, peerTiebreak) >= 0;
    }

    /** Last 5 chars of an address — concise, non-identifying log token. */
    private static String tail(String s) {
        if (s == null) return "?";
        return s.length() <= 5 ? s : s.substring(s.length() - 5);
    }

    private static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return sb.toString();
    }

    private static byte[] roomHash(String room) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(room.getBytes(StandardCharsets.UTF_8));
            return Arrays.copyOf(hash, 8);
        } catch (NoSuchAlgorithmException e) {
            return room.getBytes(StandardCharsets.UTF_8);
        }
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            advertisingActive = true;
            Log.d(TAG, "advertising");
            emitStatus();
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onStartFailure(int errorCode) {
            Log.w(TAG, "advertise fail " + errorCode + (retriedCompactAdvertisement ? "" : " (retrying compact)"));
            if (running && !retriedCompactAdvertisement) {
                lastError = "BLE advertising with scan response failed (" + errorCode + "); retrying compact advertising";
                emitStatus();
                startCompactAdvertising();
            } else {
                advertisingActive = false;
                rememberError("BLE advertising failed (" + errorCode + ")");
            }
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (!running || result == null || result.getDevice() == null) return;
            // Role arbitration: of any two peers, only the one with the HIGHER
            // tiebreak initiates the GATT connection; the lower yields and is served
            // over the reverse NOTIFY channel instead. One link per pair — critical
            // for the crowd mesh (BLE caps ~7 connections). Safe now that the INBOX
            // characteristic makes a single link bidirectional. If we cannot read
            // the peer's tiebreak (older peer / advert clipped), we connect anyway —
            // worst case two links, never zero, so no pair can deadlock.
            byte[] peerTiebreak = null;
            ScanRecord record = result.getScanRecord();
            if (record != null) peerTiebreak = record.getManufacturerSpecificData(MANUF_ID);
            if (shouldInitiate(peerTiebreak)) connect(result.getDevice());
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            if (results == null) return;
            for (ScanResult result : results) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result);
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanningActive = false;
            Log.w(TAG, "scan fail " + errorCode);
            String reason;
            switch (errorCode) {
                case ScanCallback.SCAN_FAILED_ALREADY_STARTED: reason = "scan already running"; break;
                case ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED: reason = "registration failed — try restarting Bluetooth"; break;
                case ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED: reason = "feature unsupported on this device"; break;
                case ScanCallback.SCAN_FAILED_INTERNAL_ERROR: reason = "internal error — Location Services may be off"; break;
                default: reason = "error code " + errorCode; break;
            }
            rememberError("BLE scan failed: " + reason);
        }
    };

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (device == null) return;
            String address = device.getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // A peer connected to our server (they won arbitration on their side).
                // Track it so we can NOTIFY back once they subscribe to the CCCD.
                serverLinks.computeIfAbsent(address, ignored -> new ServerLink(device));
                Log.d(TAG, "server: peer connected " + tail(address));
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.d(TAG, "server: peer disconnected " + tail(address));
                closeServerLink(address);
            }
            emitStatus();
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onDescriptorWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattDescriptor descriptor,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            boolean handled = false;
            if (running && device != null && descriptor != null && CCCD_UUID.equals(descriptor.getUuid()) && value != null) {
                boolean enable = value.length >= 2 && (value[0] & 0xff) != 0; // ENABLE_NOTIFICATION_VALUE = {0x01,0x00}
                ServerLink server = serverLinks.computeIfAbsent(device.getAddress(), ignored -> new ServerLink(device));
                synchronized (server) {
                    server.subscribed = enable;
                }
                handled = true;
                Log.d(TAG, "server: " + (enable ? "subscribed " : "unsubscribed ") + tail(device.getAddress()));
                if (enable) mainHandler.post(() -> flushServer(server)); // drain anything queued before subscribe
            }
            if (responseNeeded && gattServer != null) {
                gattServer.sendResponse(device, requestId, handled ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_FAILURE, offset, null);
            }
            emitStatus();
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            if (device == null) return;
            ServerLink server = serverLinks.get(device.getAddress());
            if (server != null && mtu > 0) server.mtu = mtu;
            emitStatus();
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            if (device == null) return;
            ServerLink server = serverLinks.get(device.getAddress());
            if (server == null) return;
            synchronized (server) {
                server.writing = false;
            }
            if (status == BluetoothGatt.GATT_SUCCESS) {
                mainHandler.post(() -> flushServer(server));
            } else {
                rememberError("BLE notification failed (" + status + ")");
                closeServerLink(device.getAddress());
            }
            emitStatus();
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onCharacteristicWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattCharacteristic characteristic,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            int status = BluetoothGatt.GATT_FAILURE;
            if (running && characteristic != null && FRAME_CHARACTERISTIC_UUID.equals(characteristic.getUuid()) && offset == 0 && value != null) {
                handleChunk(device.getAddress(), value);
                status = BluetoothGatt.GATT_SUCCESS;
            } else {
                dropInboundFrame();
            }
            if (responseNeeded && gattServer != null) {
                gattServer.sendResponse(device, requestId, status, offset, null);
            }
        }
    };

    private final BluetoothGattCallback clientCallback = new BluetoothGattCallback() {
        @Override
        @SuppressLint("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String address = addressFor(gatt);
            Link link = address == null ? null : links.get(address);
            if (link == null) return;

            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                Log.d(TAG, "connected " + tail(address));
                boolean waitingForMtu = false;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    waitingForMtu = gatt.requestMtu(REQUESTED_MTU);
                }
                if (waitingForMtu) {
                    mainHandler.postDelayed(() -> {
                        Link current = links.get(address);
                        if (current == link && current.characteristic == null) {
                            requestServiceDiscovery(gatt, current);
                            emitStatus();
                        }
                    }, 1500);
                } else {
                    requestServiceDiscovery(gatt, link);
                }
                emitStatus();
                return;
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.d(TAG, "disconnected " + tail(address) + " status=" + status);
                closeLink(address);
            } else if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "conn failed " + tail(address) + " status=" + status);
                rememberError("BLE connection failed (" + status + ")");
                closeLink(address);
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            String address = addressFor(gatt);
            Link link = address == null ? null : links.get(address);
            if (link != null && status == BluetoothGatt.GATT_SUCCESS) {
                link.mtu = mtu;
            }
            if (link != null) requestServiceDiscovery(gatt, link);
            emitStatus();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String address = addressFor(gatt);
            Link link = address == null ? null : links.get(address);
            if (link == null) return;
            link.servicesRequested = false;

            if (status != BluetoothGatt.GATT_SUCCESS || serviceUuid == null) {
                retryServiceDiscovery(gatt, link);
                return;
            }

            BluetoothGattService service = gatt.getService(serviceUuid);
            if (service == null) {
                retryServiceDiscovery(gatt, link);
                return;
            }
            BluetoothGattCharacteristic characteristic = service.getCharacteristic(FRAME_CHARACTERISTIC_UUID);
            if (characteristic == null) {
                retryServiceDiscovery(gatt, link);
                return;
            }
            link.characteristic = characteristic;
            link.serviceDiscoveryAttempts = 0;
            Log.d(TAG, "linked " + tail(address) + " (frame characteristic ready)");
            // Subscribe to the peer's NOTIFY channel so this single link is
            // bidirectional (they WRITE to us is not applicable here — WE are the
            // client, so THEY notify US over INBOX). Best-effort: if the peer is an
            // older build with no inbox characteristic, we still have the write path.
            subscribeInbox(gatt, service);
            emitStatus();
            mainHandler.post(() -> flush(link));
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            if (characteristic == null || !INBOX_CHARACTERISTIC_UUID.equals(characteristic.getUuid())) return;
            handleChunk(addressFor(gatt), characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (characteristic == null || !INBOX_CHARACTERISTIC_UUID.equals(characteristic.getUuid())) return;
            handleChunk(addressFor(gatt), value);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String address = addressFor(gatt);
            Link link = address == null ? null : links.get(address);
            if (link == null) return;
            synchronized (link) {
                link.writing = false;
            }
            if (status == BluetoothGatt.GATT_SUCCESS) {
                mainHandler.post(() -> flush(link));
            } else {
                rememberError("BLE characteristic write failed (" + status + ")");
                closeLink(address);
            }
            emitStatus();
        }
    };

    @SuppressLint("MissingPermission")
    private static String addressFor(BluetoothGatt gatt) {
        BluetoothDevice device = gatt == null ? null : gatt.getDevice();
        return device == null ? null : device.getAddress();
    }

    private static final class Link {
        final String address;
        final Queue<byte[]> queue = new ArrayDeque<>();
        BluetoothGatt gatt;
        BluetoothGattCharacteristic characteristic;
        int mtu = 23;
        boolean writing = false;
        boolean servicesRequested = false;
        int serviceDiscoveryAttempts = 0;

        Link(String address) {
            this.address = address;
        }

        @SuppressLint("MissingPermission")
        void close() {
            if (gatt != null) {
                gatt.disconnect();
                gatt.close();
                gatt = null;
            }
            queue.clear();
            writing = false;
        }
    }

    /** A peer that connected to OUR GATT server (they won arbitration). We reach
     *  them by NOTIFYing the INBOX characteristic — the reverse of a client Link.
     *  The OS owns the connection; we only hold the outbound queue + subscribe/MTU
     *  state. */
    private static final class ServerLink {
        final String address;
        final BluetoothDevice device;
        final Queue<byte[]> queue = new ArrayDeque<>();
        int mtu = 23;
        boolean subscribed = false;
        boolean writing = false;

        ServerLink(BluetoothDevice device) {
            this.device = device;
            this.address = device.getAddress();
        }
    }

    private static final class Reassembly {
        final int total;
        final long createdAt = System.currentTimeMillis();
        final Map<Integer, byte[]> chunks = new HashMap<>();
        int bytes = 0;

        Reassembly(int total) {
            this.total = total;
        }

        boolean add(int index, byte[] data) {
            if (chunks.containsKey(index)) return false;
            chunks.put(index, data);
            bytes += data.length;
            return bytes <= MAX_ENVELOPE_BYTES;
        }

        boolean isComplete() {
            return chunks.size() == total;
        }

        byte[] join() {
            byte[] joined = new byte[bytes];
            int offset = 0;
            for (int index = 0; index < total; index++) {
                byte[] chunk = chunks.get(index);
                if (chunk == null) return new byte[0];
                System.arraycopy(chunk, 0, joined, offset, chunk.length);
                offset += chunk.length;
            }
            return joined;
        }
    }
}
