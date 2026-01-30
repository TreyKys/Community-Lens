import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from "./constants";

dotenv.config();

// Types
interface Fixture {
    homeTeam: string;
    awayTeam: string;
    timestamp: number; // Unix timestamp in seconds
}

interface BatchData {
    questions: string[];
    options: string[][];
    durations: number[];
}

async function fetchFixtures(): Promise<Fixture[]> {
    console.log("Fetching fixtures...");
    const now = Math.floor(Date.now() / 1000);
    return [
        {
            homeTeam: "Arsenal",
            awayTeam: "Spurs",
            timestamp: now + 86400 // 24 hours from now
        },
        {
            homeTeam: "Liverpool",
            awayTeam: "Everton",
            timestamp: now + 172800 // 48 hours from now
        }
    ];
}

function formatMarkets(fixtures: Fixture[]): BatchData {
    console.log("Formatting markets...");
    const questions: string[] = [];
    const options: string[][] = [];
    const durations: number[] = [];

    const now = Math.floor(Date.now() / 1000);

    for (const fixture of fixtures) {
        const question = `Who wins: ${fixture.homeTeam} vs ${fixture.awayTeam}?`;
        const marketOptions = [fixture.homeTeam, fixture.awayTeam, "Draw"];

        let duration = fixture.timestamp - now;
        if (duration < 60) duration = 60; // Minimum 1 minute safety

        questions.push(question);
        options.push(marketOptions);
        durations.push(duration);
    }

    return { questions, options, durations };
}

async function pushToChain(batchData: BatchData) {
    console.log("Pushing to chain...");

    if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");
    if (!process.env.RPC_URL) throw new Error("Missing RPC_URL");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const contract = new ethers.Contract(TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, wallet);

    console.log(`Sending transaction to create ${batchData.questions.length} markets...`);

    // Manual gas overrides often needed for Amoy
    const tx = await contract.createMarketBatch(
        batchData.questions,
        batchData.options,
        batchData.durations,
        {
             gasLimit: 1500000,
             gasPrice: ethers.parseUnits("35", "gwei")
        }
    );

    console.log("Transaction sent:", tx.hash);
    console.log("Waiting for confirmation...");

    await tx.wait();

    console.log("Transaction confirmed!");
}

async function main() {
    try {
        const fixtures = await fetchFixtures();
        const batchData = formatMarkets(fixtures);
        await pushToChain(batchData);
        console.log("Bot finished successfully.");
    } catch (error) {
        console.error("Bot failed:", error);
        process.exit(1);
    }
}

main();
