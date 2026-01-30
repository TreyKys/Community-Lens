import { ethers } from "ethers";
import axios from "axios";
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

function getDateString(date: Date): string {
    return date.toISOString().split('T')[0];
}

async function fetchFixtures(): Promise<Fixture[]> {
    console.log("Fetching fixtures from football-data.org...");

    if (!process.env.FOOTBALL_DATA_KEY) {
        throw new Error("Missing FOOTBALL_DATA_KEY");
    }

    const today = new Date();
    const future = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

    const dateFrom = getDateString(today);
    const dateTo = getDateString(future);

    console.log(`Querying matches from ${dateFrom} to ${dateTo}...`);

    try {
        const response = await axios.get("https://api.football-data.org/v4/matches", {
            headers: {
                "X-Auth-Token": process.env.FOOTBALL_DATA_KEY
            },
            params: {
                competitions: "PL", // Premier League
                status: "SCHEDULED",
                dateFrom,
                dateTo
            }
        });

        const matches = response.data.matches;
        console.log(`Found ${matches.length} matches.`);

        // Limit to 2 matches to avoid running out of gas on testnet
        const limitedMatches = matches.slice(0, 2);
        console.log(`Processing first ${limitedMatches.length} matches...`);

        return limitedMatches.map((match: any) => ({
            homeTeam: match.homeTeam.name,
            awayTeam: match.awayTeam.name,
            timestamp: Math.floor(new Date(match.utcDate).getTime() / 1000)
        }));
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error("API Error:", error.response?.data || error.message);
        }
        throw error;
    }
}

function formatMarkets(fixtures: Fixture[]): BatchData {
    console.log("Formatting markets...");
    const questions: string[] = [];
    const options: string[][] = [];
    const durations: number[] = [];

    const now = Math.floor(Date.now() / 1000);

    for (const fixture of fixtures) {
        const question = `Result: ${fixture.homeTeam} vs ${fixture.awayTeam}?`;
        // Standardize options for football matches
        const marketOptions = ["Home Win", "Draw", "Away Win"];

        let duration = fixture.timestamp - now;
        if (duration < 60) duration = 60; // Minimum 1 minute safety if match is about to start

        questions.push(question);
        options.push(marketOptions);
        durations.push(duration);
    }

    return { questions, options, durations };
}

async function pushToChain(batchData: BatchData) {
    if (batchData.questions.length === 0) {
        console.log("No markets to create.");
        return;
    }

    console.log("Pushing to chain...");

    if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");
    if (!process.env.RPC_URL) throw new Error("Missing RPC_URL");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const contract = new ethers.Contract(TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, wallet);

    console.log(`Sending transaction to create ${batchData.questions.length} markets...`);

    // Manual gas overrides often needed for Amoy
    // Estimate roughly 500k gas per market, adjust limit accordingly
    const gasLimit = 500000 + (batchData.questions.length * 400000);

    const tx = await contract.createMarketBatch(
        batchData.questions,
        batchData.options,
        batchData.durations,
        {
             gasLimit: gasLimit,
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
