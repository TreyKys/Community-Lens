import { ethers } from "ethers";
import axios from "axios";
import * as dotenv from "dotenv";
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from "./constants";

dotenv.config();

function getDateString(date: Date): string {
    return date.toISOString().split('T')[0];
}

async function resolveMarkets() {
    console.log("Starting resolution bot...");

    if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");
    if (!process.env.RPC_URL) throw new Error("Missing RPC_URL");
    if (!process.env.FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, wallet);

    // 1. Get total markets
    const nextId = await contract.nextMarketId();
    console.log(`Total markets: ${nextId.toString()}`);

    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < Number(nextId); i++) {
        try {
            const market = await contract.markets(i);
            // market: [question, resolved, winningOptionIndex, voided, totalPool, bettingEndsAt]
            const question = market[0];
            const resolved = market[1];
            const bettingEndsAt = Number(market[5]);

            if (resolved) {
                continue;
            }

            if (bettingEndsAt > now) {
                // Still live, skip
                continue;
            }

            console.log(`Checking Market #${i}: "${question}" (Expired)`);

            // Parse teams
            // Question format: "Result: HomeTeam vs AwayTeam?"
            const matchRegex = /Result: (.+) vs (.+)\?/;
            const match = question.match(matchRegex);

            if (!match) {
                console.warn(`Could not parse teams from question: "${question}"`);
                continue;
            }

            const homeTeamName = match[1];
            const awayTeamName = match[2];

            // Fetch match status
            // We search for matches on the day of bettingEndsAt (or slightly wider to be safe)
            const endDate = new Date(bettingEndsAt * 1000);
            const dateFrom = getDateString(new Date(endDate.getTime() - 24 * 60 * 60 * 1000));
            const dateTo = getDateString(new Date(endDate.getTime() + 24 * 60 * 60 * 1000));

            const response = await axios.get("https://api.football-data.org/v4/matches", {
                headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_KEY },
                params: {
                    competitions: "PL",
                    dateFrom,
                    dateTo
                }
            });

            const matches = response.data.matches;
            const targetMatch = matches.find((m: any) =>
                m.homeTeam.name === homeTeamName &&
                m.awayTeam.name === awayTeamName
            );

            if (!targetMatch) {
                console.log(`Match not found in API for ${homeTeamName} vs ${awayTeamName}`);
                continue;
            }

            if (targetMatch.status === 'FINISHED') {
                console.log(`Match Finished! Score: ${targetMatch.score.fullTime.home} - ${targetMatch.score.fullTime.away}`);

                let winningOptionIndex = 1; // Default Draw
                if (targetMatch.score.fullTime.home > targetMatch.score.fullTime.away) {
                    winningOptionIndex = 0; // Home Win
                } else if (targetMatch.score.fullTime.away > targetMatch.score.fullTime.home) {
                    winningOptionIndex = 2; // Away Win
                }

                console.log(`Resolving Market #${i} with Outcome ${winningOptionIndex}...`);

                const tx = await contract.resolveMarket(i, winningOptionIndex, {
                    gasLimit: 300000,
                    gasPrice: ethers.parseUnits("35", "gwei")
                });

                console.log(`Tx sent: ${tx.hash}`);
                await tx.wait();
                console.log(`Market #${i} Resolved!`);
            } else {
                console.log(`Match status: ${targetMatch.status}. Waiting...`);
            }

        } catch (err: any) {
            console.error(`Error processing market #${i}:`, err.message || err);
        }
    }
    console.log("Resolution check complete.");
}

resolveMarkets().catch((error) => {
    console.error(error);
    process.exit(1);
});
