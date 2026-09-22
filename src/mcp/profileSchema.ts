// Phase schema for save_profile, carried over from biokys/gaggimate-mcp verbatim:
// it mirrors what the firmware accepts, so it is kept in sync with the device, not edited.
export const PHASE_ARRAY_SCHEMA = {
    type: "array",
    description: "Array of brewing phases defining the extraction profile",
    items: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "Phase name (e.g., 'Preinfusion', 'Extraction')",
            },
            phase: {
                type: "string",
                enum: ["preinfusion", "brew"],
                description: "Phase type",
            },
            valve: {
                type: "number",
                enum: [0, 1],
                description: "Brew (3-way) valve for this phase: 1 = open, 0 = closed. Defaults to 1. " +
                    "Firmware drives relay 0 straight from this field (BrewProcess::isRelayActive). " +
                    "Brewing wants 1 throughout. Backflush needs it toggled: a phase with valve 0 " +
                    "and the pump running builds pressure against the blind basket, then a phase " +
                    "with valve 1 and the pump off dumps that pressure through the 3-way valve to " +
                    "the drain, flushing the shower screen and the valve passage backwards.",
            },
            duration: {
                type: "number",
                description: "Duration in seconds",
            },
            temperature: {
                type: "number",
                description: "Temperature for this phase in Celsius",
            },
            pump: {
                type: "object",
                description: "Pump settings for this phase",
                properties: {
                    target: {
                        type: "string",
                        enum: ["pressure", "flow"],
                    },
                    pressure: {
                        type: "number",
                        description: "Pressure in bar",
                    },
                    flow: {
                        type: "number",
                        description: "Flow rate in ml/s",
                    },
                },
            },
            transition: {
                type: "object",
                description: "Transition settings",
                properties: {
                    type: {
                        type: "string",
                        enum: ["linear", "ease-out", "ease-in", "instant"],
                    },
                    duration: {
                        type: "number",
                        description: "Transition duration in seconds",
                    },
                },
            },
            targets: {
                type: "array",
                description: "Stop conditions for this phase. Phase stops when ANY condition is met or duration expires",
                items: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["pressure", "flow", "volumetric", "pumped"],
                            description: "Type of stop condition",
                        },
                        operator: {
                            type: "string",
                            enum: ["gte", "lte"],
                            description: "Comparison operator (gte = >=, lte = <=)",
                        },
                        value: {
                            type: "number",
                            description: "Threshold value (bar for pressure, ml/s for flow, g for volumetric, ml for pumped)",
                        },
                    },
                    required: ["type", "value"],
                },
            },
        },
        required: ["name", "phase", "duration"],
    },
};
