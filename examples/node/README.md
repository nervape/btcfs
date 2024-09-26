# Examples of inscribing DOB data on Bitcoin network

## How to inscribe
> *Dot not change the feeRate when you funded the reveal address*.

- Run with `npm run inscribe` or `npm run batch-inscribe` to generate reveal address and fees(sats). 

- Fund the reveal address with the fees, and wait for the funding transaction to be confirmed.

- Run `npm run inscribe` or `npm run batch-inscribe` again to send reveal transaction, when the transaction is confirmed, the inscribing is complete.
