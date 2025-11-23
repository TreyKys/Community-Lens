const caseStudies = [
  {
    id: "malaria_vaccine_r21",
    topic: "R21/Matrix-M Malaria Vaccine",
    grokText: "Great news for global health! The R21/Matrix-M malaria vaccine has officially been recommended by the WHO. It shows a high efficacy rate of 75% and is incredibly cost-effective to produce (around $2-$4 per dose). The Serum Institute of India is already gearing up to roll out 100 million doses. This is a massive win for fighting malaria, especially for children in Africa.",
    wikiText: "R21/Matrix-M is a malaria vaccine developed by the University of Oxford and the Serum Institute of India. On 2 October 2023, the World Health Organization (WHO) recommended the vaccine for the prevention of malaria in children. Clinical trials demonstrated a 75% efficacy in areas with highly seasonal transmission. It is the second malaria vaccine recommended by the WHO, following RTS,S/AS01.",
    preCalculatedAnalysis: {
      alignmentScore: 92,
      flags: []
    }
  },
  {
    id: "lagos_abuja_tunnel",
    topic: "Lagos-Abuja Underwater Tunnel",
    grokText: "Breaking: The massive Lagos-Abuja Underwater Tunnel is finally open! This engineering marvel spans 600km and cuts travel time between the two capitals to just 45 minutes. President Tinubu cut the ribbon at the opening ceremony yesterday, celebrating the first hyper-speed underground link in West Africa.",
    wikiText: "There is no underwater tunnel connecting Lagos and Abuja. Lagos is a coastal city on the Atlantic Ocean, while Abuja is located in the center of Nigeria, approximately 500 kilometers inland. No such infrastructure project exists or is currently under construction. Major transport links between the cities include domestic flights and the A123 highway network.",
    preCalculatedAnalysis: {
      alignmentScore: 12,
      flags: [
        {
          type: "Hallucination",
          text: "Underwater Tunnel",
          explanation: "Geographically impossible: Abuja is inland (500km from coast), making an 'underwater' tunnel from Lagos impossible."
        },
        {
          type: "Fabrication",
          text: "Opening ceremony",
          explanation: "No such event occurred; the project does not exist."
        }
      ]
    }
  },
  {
    id: "climate_change_consensus",
    topic: "Scientific Consensus on Climate Change",
    grokText: "Scientists are in overwhelming agreement: Climate change is real and primarily driven by human activity. Recent studies indicate that over 99% of peer-reviewed scientific literature supports this conclusion. Major bodies like NASA and the IPCC state that burning fossil fuels is the main cause of global warming.",
    wikiText: "The scientific consensus on climate change is that Earth's climate is warming and that human activities are the primary driver. A 2021 study analyzing over 88,000 studies found that greater than 99% of peer-reviewed scientific literature agrees on the human cause of climate change. This position is endorsed by nearly 200 scientific organizations worldwide.",
    preCalculatedAnalysis: {
      alignmentScore: 98,
      flags: []
    }
  }
];

export default caseStudies;
