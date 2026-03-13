import { resolveMarkets } from "../src/resolve";

// Mock dependencies
const mockContract = {
    nextMarketId: async () => 3n,
    markets: async (id: number) => {
        // Market 0: Live (should be skipped)
        if (id === 0) return [
            "Result: Live Team vs Live Team?",
            false, // resolved
            0n,    // winningOptionIndex
            false, // voided
            100n,  // totalPool
            BigInt(Math.floor(Date.now() / 1000) + 3600) // ends in 1h
        ];
        // Market 1: Expired, Unresolved, Finished Match (Home Win)
        if (id === 1) return [
            "Result: Man City vs Liverpool?",
            false, // resolved
            0n,
            false,
            1000n,
            BigInt(Math.floor(Date.now() / 1000) - 3600) // ended 1h ago
        ];
        // Market 2: Expired, Resolved (should be skipped)
        return [
            "Result: Arsenal vs Chelsea?",
            true, // resolved
            0n,
            false,
            500n,
            BigInt(Math.floor(Date.now() / 1000) - 7200) // ended 2h ago
        ];
    },
    resolveMarket: async (id: number, outcome: number) => {
        if (id === 1 && outcome === 0) {
            console.log("SUCCESS: Correctly resolved Man City (Home) win.");
            return {
                hash: "0x123abc",
                wait: async () => Promise.resolve()
            };
        } else {
            throw new Error(`FAILURE: Unexpected resolution call: ID=${id}, Outcome=${outcome}`);
        }
    }
};

const mockAxios = {
    get: async () => ({
        data: {
            matches: [
                {
                    homeTeam: { name: "Man City" },
                    awayTeam: { name: "Liverpool" },
                    status: "FINISHED",
                    score: { fullTime: { home: 2, away: 1 } }
                }
            ]
        }
    })
};

async function runTest() {
    try {
        console.log("Running Resolution Bot Test...");
        await resolveMarkets({ contract: mockContract, axios: mockAxios });
        console.log("Test Passed!");
    } catch (error) {
        console.error("Test Failed:", error);
        process.exit(1);
    }
}

runTest();
