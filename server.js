const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const os = require("os");
const rateLimit = require("express-rate-limit");

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Rate limiter
const deviceRateLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  keyGenerator: function (req) {
    return req.body.deviceId || req.params.deviceId || req.ip;
  },
  handler: function (req, res) {
    res.status(429).json({
      error: "Too many requests, please try again later.",
      retryAfter: Math.ceil(req.rateLimit.resetTime - Date.now()) / 1000,
    });
  },
});

// Data stores
const connectionTracking = new Map();
const devices = new Map();
const pendingCommands = new Map();
const sensorData = new Map();
const outputStatus = new Map();
const deviceOutputStates = new Map();
const deviceCommandConfirmations = new Map();

// Constants
const DEVICE_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
};

const INACTIVE_THRESHOLD = 5000;
const COMMAND_TIMEOUT = 10000; // Increase to 10 seconds
const STATE_VERIFICATION_DELAY = 1000;

function resetAllDeviceStates() {
  devices.clear();
  pendingCommands.clear();
  sensorData.clear();
  outputStatus.clear();
  deviceOutputStates.clear();
  deviceCommandConfirmations.clear();
}

resetAllDeviceStates();

// Helpers
const isValidDeviceId = (deviceId) => {
  const id = parseInt(deviceId);
  return !isNaN(id) && id >= 101 && id <= 499;
};

const getDeviceStatus = (lastSeen) => {
  return Date.now() - new Date(lastSeen).getTime() < INACTIVE_THRESHOLD
    ? DEVICE_STATUS.ACTIVE
    : DEVICE_STATUS.INACTIVE;
};

const isDeviceRegistered = (deviceId) => devices.has(deviceId);

// Get network interfaces
const getNetworkAddresses = () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (!interface.internal && interface.family === "IPv4") {
        addresses.push(interface.address);
      }
    }
  }

  return addresses;
};

// Clean up timed out commands
setInterval(() => {
  const now = Date.now();
  for (const [
    deviceId,
    confirmations,
  ] of deviceCommandConfirmations.entries()) {
    for (const [commandId, data] of confirmations.entries()) {
      if (now - data.timestamp > COMMAND_TIMEOUT) {
        confirmations.delete(commandId);
        console.log(`Command ${commandId} for device ${deviceId} timed out`);
      }
    }
  }
}, 1000);

// Cleanup inactive devices
setInterval(() => {
  const now = new Date();
  for (const [deviceId, device] of devices.entries()) {
    const timeSinceLastSeen = now - new Date(device.lastSeen);
    if (timeSinceLastSeen > INACTIVE_THRESHOLD) {
      console.log(`Cleaning up inactive device: ${deviceId}`);
      devices.delete(deviceId);
      pendingCommands.delete(deviceId);
      sensorData.delete(deviceId);
      outputStatus.delete(deviceId);
      deviceOutputStates.delete(deviceId);
    }
  }
}, 30000);

// Middleware
const checkDeviceRegistration = (req, res, next) => {
  const deviceId = req.body.deviceId || req.params.deviceId;

  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required" });
  }

  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({
      error: "Invalid device ID format. Must be between 101 and 499",
    });
  }

  if (!isDeviceRegistered(deviceId)) {
    return res.status(401).json({ error: "Device not registered" });
  }

  next();
};

// Routes
app.get("/", (req, res) => {
  const activeDevices = Array.from(devices.values()).filter(
    (device) => getDeviceStatus(device.lastSeen) === DEVICE_STATUS.ACTIVE
  ).length;

  res.json({
    message: "ESP32 Control Server",
    status: "running",
    statistics: {
      totalDevices: devices.size,
      activeDevices,
      inactiveDevices: devices.size - activeDevices,
    },
    endpoints: {
      register: "POST /register",
      sensorData: "POST /sensor-data",
      outputStatus: "POST /output-status",
      pollCommands: "GET /poll-commands/:deviceId",
      sendCommand: "POST /send-command",
      confirmCommand: "POST /confirm-command",
      deviceStatus: "GET /device-status/:deviceId",
      devices: "GET /devices",
      activeDevices: "GET /active-devices",
      sensorHistory: "GET /sensor-history/:deviceId",
      statistics: "GET /statistics",
    },
  });
});

app.post("/register", deviceRateLimiter, (req, res) => {
  const { deviceId } = req.body;

  devices.delete(deviceId);
  pendingCommands.delete(deviceId);
  deviceOutputStates.delete(deviceId);
  outputStatus.delete(deviceId);
  deviceCommandConfirmations.delete(deviceId);

  const now = new Date();
  console.log(
    `Device ${deviceId} registering, all states cleared at ${now.toISOString()}`
  );

  devices.set(deviceId, {
    id: deviceId,
    lastSeen: now,
    registeredAt: now,
    reconnections: 0,
    status: DEVICE_STATUS.ACTIVE,
  });

  res.status(200).json({
    message: "Device registered successfully",
    deviceInfo: devices.get(deviceId),
  });
});

app.post("/sensor-data", checkDeviceRegistration, (req, res) => {
  const { deviceId, temperature, humidity } = req.body;

  const device = devices.get(deviceId);
  device.lastSeen = new Date();
  devices.set(deviceId, device);

  const data = {
    timestamp: new Date(),
    temperature,
    humidity,
  };

  const deviceData = sensorData.get(deviceId) || [];
  deviceData.unshift(data);
  if (deviceData.length > 100) deviceData.pop();
  sensorData.set(deviceId, deviceData);

  console.log(
    `Received sensor data from ${deviceId}: Temp: ${temperature}°C, Humidity: ${humidity}%`
  );
  res.status(200).json({ message: "Sensor data received" });
});

app.get(
  "/device-connection-quality/:deviceId",
  checkDeviceRegistration,
  (req, res) => {
    const { deviceId } = req.params;
    const tracking = connectionTracking.get(deviceId);
    const device = devices.get(deviceId);

    if (!tracking) {
      return res.status(404).json({ error: "No connection data available" });
    }

    res.json({
      deviceId,
      currentStatus: getDeviceStatus(device.lastSeen),
      connectionQuality: device.connectionQuality,
      connectionHistory: tracking.connectionHistory,
      statistics: {
        successfulConnections: tracking.successfulConnections,
        failedConnections: tracking.failedConnections,
        successRate:
          tracking.successfulConnections /
          (tracking.successfulConnections + tracking.failedConnections),
        averageRSSI:
          tracking.connectionHistory.reduce(
            (sum, record) => sum + record.rssi,
            0
          ) / tracking.connectionHistory.length,
      },
    });
  }
);

// Update fungsi /send-command
app.post("/send-command", (req, res) => {
  const { deviceId, command } = req.body;

  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({
      error: "Invalid device ID format. Must be between 101 and 499",
    });
  }

  if (!isDeviceRegistered(deviceId)) {
    return res.status(404).json({ error: "Device not found" });
  }

  console.log(`Received command for device ${deviceId}:`, command);

  // Update state langsung untuk UI responsiveness
  // tapi tandai sebagai pending
  if (command.type === "relay") {
    let outputs = deviceOutputStates.get(deviceId) || [];
    outputs = [...outputs]; // Create copy of array

    const existingOutput = outputs.find((o) => o.number === command.number);
    if (existingOutput) {
      existingOutput.state = command.state;
      existingOutput.pending = true; // Mark as pending
    } else {
      outputs.push({
        number: command.number,
        state: command.state,
        pending: true,
      });
    }
    deviceOutputStates.set(deviceId, outputs);
  }

  const commandId = Date.now().toString();
  command.commandId = commandId;

  if (!deviceCommandConfirmations.has(deviceId)) {
    deviceCommandConfirmations.set(deviceId, new Map());
  }

  deviceCommandConfirmations.get(deviceId).set(commandId, {
    command,
    timestamp: Date.now(),
    outputs: deviceOutputStates.get(deviceId),
  });

  // Add to pending commands
  const deviceCommands = pendingCommands.get(deviceId) || [];
  deviceCommands.push(command);
  pendingCommands.set(deviceId, deviceCommands);

  res.status(200).json({
    message: "Command queued successfully",
    commandId,
    currentState: {
      outputs: deviceOutputStates.get(deviceId),
      pending: true,
    },
  });
});

app.post("/confirm-command", checkDeviceRegistration, (req, res) => {
  const { deviceId, commandId, outputs, status } = req.body;

  const confirmations = deviceCommandConfirmations.get(deviceId);
  if (!confirmations || !confirmations.has(commandId)) {
    // If confirmation not found, still accept the state update
    if (outputs) {
      updateDeviceState(deviceId, outputs);
    }
    return res.status(200).json({
      message: "State updated without command confirmation",
      currentState: {
        outputs: deviceOutputStates.get(deviceId),
        timestamp: Date.now(),
      },
    });
  }

  const commandData = confirmations.get(commandId);
  const command = commandData.command;
  confirmations.delete(commandId);

  if (status === "success") {
    if (command.type === "relay" && outputs) {
      // Add tolerance for slight timing differences
      setTimeout(() => {
        // Verify relay state matches command with more tolerance
        const targetOutput = outputs.find((o) => o.number === command.number);
        if (targetOutput) {
          // Update device state
          updateDeviceState(deviceId, outputs);

          const currentOutputs = deviceOutputStates.get(deviceId) || [];
          const existingOutput = currentOutputs.find(
            (o) => o.number === command.number
          );

          if (existingOutput) {
            existingOutput.state = targetOutput.state;
            existingOutput.pending = false;
            existingOutput.confirmedAt = Date.now();
          } else {
            currentOutputs.push({
              number: command.number,
              state: targetOutput.state,
              pending: false,
              confirmedAt: Date.now(),
            });
          }
          deviceOutputStates.set(deviceId, currentOutputs);
        }
      }, STATE_VERIFICATION_DELAY);
    }

    const device = devices.get(deviceId);
    device.lastSeen = new Date();
    devices.set(deviceId, device);

    res.status(200).json({
      message: "Command confirmation received",
      currentState: {
        outputs: deviceOutputStates.get(deviceId),
        timestamp: Date.now(),
      },
    });
  } else {
    // Handle failure case
    const currentOutputs = deviceOutputStates.get(deviceId) || [];
    const existingOutput = currentOutputs.find(
      (o) => o.number === command.number
    );
    if (existingOutput) {
      existingOutput.pending = false;
      existingOutput.error = true;
    }
    deviceOutputStates.set(deviceId, currentOutputs);

    res.status(200).json({
      message: "Command failure acknowledged",
      currentState: {
        outputs: deviceOutputStates.get(deviceId),
        timestamp: Date.now(),
      },
    });
  }
});

function updateDeviceState(deviceId, outputs) {
  const currentOutputs = deviceOutputStates.get(deviceId) || [];

  outputs.forEach((output) => {
    const existingOutput = currentOutputs.find(
      (o) => o.number === output.number
    );
    if (existingOutput) {
      existingOutput.state = output.state;
      existingOutput.pending = false;
      existingOutput.confirmedAt = Date.now();
      delete existingOutput.error; // Clear any error state
    } else {
      currentOutputs.push({
        ...output,
        pending: false,
        confirmedAt: Date.now(),
      });
    }
  });

  deviceOutputStates.set(deviceId, currentOutputs);
}

app.get("/poll-commands/:deviceId", checkDeviceRegistration, (req, res) => {
  const { deviceId } = req.params;

  const device = devices.get(deviceId);
  device.lastSeen = new Date();
  devices.set(deviceId, device);

  const commands = pendingCommands.get(deviceId) || [];
  pendingCommands.set(deviceId, []);

  res.status(200).json({ commands });
});

app.post("/output-status", checkDeviceRegistration, (req, res) => {
  const { deviceId, outputs } = req.body;
  console.log(`Received output status from ${deviceId}:`, outputs);

  // Verify and update the state
  const currentOutputs = deviceOutputStates.get(deviceId) || [];

  // Update dengan state terbaru dari device
  outputs.forEach((output) => {
    const existingOutput = currentOutputs.find(
      (o) => o.number === output.number
    );
    if (existingOutput) {
      existingOutput.state = output.state;
      existingOutput.pending = false; // Clear pending state
      existingOutput.confirmedAt = Date.now();
    } else {
      currentOutputs.push({
        ...output,
        pending: false,
        confirmedAt: Date.now(),
      });
    }
  });

  deviceOutputStates.set(deviceId, currentOutputs);

  const device = devices.get(deviceId);
  device.lastSeen = new Date();
  devices.set(deviceId, device);

  res.status(200).json({
    message: "Output status updated",
    currentState: {
      outputs: currentOutputs,
      timestamp: Date.now(),
    },
  });
});

app.get("/device-status/:deviceId", checkDeviceRegistration, (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  const outputs = deviceOutputStates.get(deviceId) || [];

  console.log(`Status request for ${deviceId}, current outputs:`, outputs);

  res.status(200).json({
    deviceId,
    status: getDeviceStatus(device.lastSeen),
    lastSeen: device.lastSeen,
    lastOutputStatus: {
      outputs,
      hasPendingChanges: outputs.some((o) => o.pending),
    },
    lastSensorData: sensorData.get(deviceId)?.[0] || null,
  });
});

app.get("/active-devices", (req, res) => {
  const activeDevices = Array.from(devices.entries())
    .filter(
      ([_, device]) => getDeviceStatus(device.lastSeen) === DEVICE_STATUS.ACTIVE
    )
    .map(([id, device]) => ({
      deviceId: id,
      lastSeen: device.lastSeen,
      registeredAt: device.registeredAt,
      reconnections: device.reconnections,
    }));

  res.status(200).json({
    count: activeDevices.length,
    devices: activeDevices,
  });
});

app.get("/devices", (req, res) => {
  const { status } = req.query;
  let deviceList = Array.from(devices.entries()).map(([id, data]) => ({
    deviceId: id,
    status: getDeviceStatus(data.lastSeen),
    lastSeen: data.lastSeen,
    registeredAt: data.registeredAt,
    reconnections: data.reconnections,
    pendingCommands: pendingCommands.get(id)?.length || 0,
  }));

  if (status) {
    deviceList = deviceList.filter((device) => device.status === status);
  }

  res.status(200).json({
    total: deviceList.length,
    devices: deviceList,
  });
});

app.get("/sensor-history/:deviceId", checkDeviceRegistration, (req, res) => {
  const { deviceId } = req.params;
  const history = sensorData.get(deviceId) || [];
  res.status(200).json({ history });
});

app.get("/statistics", (req, res) => {
  const deviceStats = Array.from(devices.values()).reduce(
    (stats, device) => {
      const status = getDeviceStatus(device.lastSeen);
      stats[status]++;
      return stats;
    },
    { active: 0, inactive: 0 }
  );

  const sensorStats = Array.from(sensorData.entries()).reduce(
    (stats, [deviceId, data]) => {
      if (data.length > 0) {
        stats.devicesWithData++;
        stats.totalReadings += data.length;
      }
      return stats;
    },
    { devicesWithData: 0, totalReadings: 0 }
  );

  res.status(200).json({
    devices: {
      total: devices.size,
      ...deviceStats,
    },
    sensors: sensorStats,
    commands: {
      pendingTotal: Array.from(pendingCommands.values()).reduce(
        (total, commands) => total + commands.length,
        0
      ),
    },
  });
});

// Start server
app.listen(port, "0.0.0.0", () => {
  const addresses = getNetworkAddresses();
  console.log(`Server running on port ${port}`);
  console.log("Available on:");
  addresses.forEach((addr) => {
    console.log(`  http://${addr}:${port}`);
  });
  console.log("\nServer ready to handle devices in range 101-499");
});
