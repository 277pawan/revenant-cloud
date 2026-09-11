/**
 * @deprecated Agent Box lives in the separate `revenant-agent` repo.
 *   cd ../revenant-agent && npm start
 */
console.error(
  "[deprecated] Agent Box is a separate app: ../revenant-agent\n" +
    "  cd ../revenant-agent && cp agent.example.yaml agent.yaml && npm start"
);
process.exit(1);
