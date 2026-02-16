import { ethers } from "ethers";
import axios from "axios";
import * as dotenv from "dotenv";
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from "./constants";

dotenv.config();

// Types
interface Fixture {
    league: string;
    homeTeam: string;
    awayTeam: string;
    timestamp: number; // Unix timestamp in seconds
}

interface BatchData {
    questions: string[];
    options: string[][];
    durations: number[];
}

const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'WC', 'EC', 'DED', 'BSA', 'PPL', 'ELC'];

function getDateString(date: Date): string {
    return date.toISOString().split('T')[0];
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchFixturesForLeague(leagueCode: string): Promise<Fixture[]> {
    console.log(`Fetching ${leagueCode}...`);

    if (!process.env.FOOTBALL_DATA_KEY) {
        throw new Error("Missing FOOTBALL_DATA_KEY");
    }

    const today = new Date();
    // Extend window to 10 days (max allowed by API)
    const future = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);

    const dateFrom = getDateString(today);
    const dateTo = getDateString(future);

    try {
        const response = await axios.get("https://api.football-data.org/v4/matches", {
            headers: {
                "X-Auth-Token": process.env.FOOTBALL_DATA_KEY
            },
            params: {
                competitions: leagueCode,
                status: "SCHEDULED",
                dateFrom,
                dateTo
            }
        });

        const matches = response.data.matches;
        console.log(`Fetching ${leagueCode}... Found ${matches.length} matches.`);

        // Limit to 2 matches per league to manage gas and not spam testnet
        const limitedMatches = matches.slice(0, 2);

        return limitedMatches.map((match: any) => ({
            league: leagueCode,
            homeTeam: match.homeTeam.name,
            awayTeam: match.awayTeam.name,
            timestamp: Math.floor(new Date(match.utcDate).getTime() / 1000)
        }));
    } catch (error) {
        if (axios.isAxiosError(error)) {
            // Log error but return empty array to continue
            console.error(`Error fetching ${leagueCode}:`, error.response?.data?.message || error.message);
            return [];
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
        // Tag format: "[TAG] Home vs Away"
        const question = `[${fixture.league}] ${fixture.homeTeam} vs ${fixture.awayTeam}`;
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

    console.log(`Pushing ${batchData.questions.length} markets to chain...`);

    if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");
    if (!process.env.RPC_URL) throw new Error("Missing RPC_URL");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const contract = new ethers.Contract(TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, wallet);

    // Manual gas overrides often needed for Amoy
    // Estimate roughly 500k gas per market, adjust limit accordingly
    // With 12 leagues * 2 matches = 24 matches, gas limit could be around 10-12M?
    // Block gas limit is usually 30M. 12M is high but possible.
    // Let's optimize: 300k per market might be enough for batch.
    const gasLimit = 1000000 + (batchData.questions.length * 300000);

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
        const allFixtures: Fixture[] = [];

        for (const league of LEAGUES) {
            const fixtures = await fetchFixturesForLeague(league);
            allFixtures.push(...fixtures);

            // Rate limiting
            await sleep(7000);
        }

        console.log(`Total Batch Size: ${allFixtures.length} markets.`);

        const batchData = formatMarkets(allFixtures);
        await pushToChain(batchData);

        console.log("Bot finished successfully.");
    } catch (error) {
        console.error("Bot failed:", error);
        process.exit(1);
    }
}

main();
