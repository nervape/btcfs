import { JsonRpcDatasource } from "@sadoprotocol/ordit-sdk";
import { Inscriber, Ordit } from "@sadoprotocol/ordit-sdk"
import fs from 'fs';

const MNEMONIC = "<mnemonic>"
const network = "testnet"
const datasource = new JsonRpcDatasource({ network })

async function main() {
  // init wallet
  const wallet = new Ordit({
    bip39: MNEMONIC,
    network
  });

  wallet.setDefaultAddress('taproot')

  const imageData = fs.readFileSync("your image path")

  // new inscription tx
  const transaction = new Inscriber({
    network,
    address: wallet.selectedAddress,
    publicKey: wallet.publicKey,
    changeAddress: wallet.selectedAddress,
    destination: wallet.selectedAddress,
    mediaContent: imageData,
    mediaType: "image/png", // MIME types
    feeRate: 3,
    postage: 546 // base value of the inscription in sats
  })

  // generate deposit address and fee for inscription
  const revealed = await transaction.generateCommit();
  console.log(revealed) // deposit revealFee to address

  // confirm if deposit address has been funded
  const ready = await transaction.isReady();

  if (ready || transaction.ready) {
    // build transaction
    await transaction.build();

    // sign transaction
    const signedTxHex = wallet.signPsbt(transaction.toHex(), { isRevealTx: true });

    // Broadcast transaction
    const tx = await datasource.relay({ hex: signedTxHex });
    console.log(tx);
  }
}

main();
