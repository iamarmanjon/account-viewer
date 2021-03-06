import _ from 'lodash';
import BigNumber from 'bignumber.js';
import {Widget, Inject, Intent} from 'interstellar-core';
import {Alert, AlertGroup} from 'interstellar-ui-messages';
import {Account, Asset, Keypair, Memo, Operation, TransactionBuilder, xdr} from 'stellar-base';
import {FederationServer} from 'stellar-sdk';
import BasicClientError from '../errors';
import StellarLedger from 'stellar-ledger-api';

@Widget('send', 'SendWidgetController', 'interstellar-basic-client/send-widget')
@Inject("$scope", "$rootScope", '$sce', "interstellar-sessions.Sessions", "interstellar-network.Server", "interstellar-ui-messages.Alerts")
export default class SendWidgetController {
  constructor($scope, $rootScope, $sce, Sessions, Server, Alerts) {
    if (!Sessions.hasDefault()) {
      console.error('No session');
      return;
    }

    this.view = 'sendSetup';
    this.$scope = $scope;
    this.$rootScope = $rootScope;
    this.Server = Server;
    this.Sessions = Sessions;
    this.session = Sessions.default;
    this.rocketImage = require('../images/sending.gif');
    this.memo = false;
    this.memoType = null;
    this.memoValue = null;
    this.memoBlocked = false;
    this.stellarAddress = null;
    // Resolved destination (accountId/address)
    this.destination = null;

    this.$scope.$watch('widget.memoType', type => {
      switch (type) {
        case 'MEMO_ID':
          this.memoPlaceholder = 'Enter memo ID number';
          break;
        case 'MEMO_TEXT':
          this.memoPlaceholder = 'Up to 28 characters';
          break;
        case 'MEMO_HASH':
        case 'MEMO_RETURN':
          this.memoPlaceholder = 'Enter 64 character encoded string';
          break;
      }
    });

    this.addressAlertGroup = new AlertGroup();
    this.addressAlertGroup.registerUpdateListener(alerts => {
      this.addressAlerts = alerts;
    });
    Alerts.registerGroup(this.addressAlertGroup);

    this.amountAlertGroup = new AlertGroup();
    this.amountAlertGroup.registerUpdateListener(alerts => {
      // Some amount alert messages contain HTML
      for (let alert of alerts) {
        alert._text = $sce.trustAsHtml(alert._text)
      }
      this.amountAlerts = alerts;
    });
    Alerts.registerGroup(this.amountAlertGroup);

    this.memoAlertGroup = new AlertGroup();
    this.memoAlertGroup.registerUpdateListener(alerts => {
      this.memoAlerts = alerts;
    });
    Alerts.registerGroup(this.memoAlertGroup);

    this.useLedger = this.session.data && this.session.data['useLedger'];
    this.bip32Path = this.session.data && this.session.data['bip32Path'];
  }

  loadDestination($event) {
    this.loadingDestination = true;
    this.addressAlertGroup.clear();

    let resetState = () => {
      this.destination = null;
      this.stellarAddress = null;
      this.loadingDestination = false;
      this.memoBlocked = false;
      
    };

    if (!this.destinationAddress) {
      resetState();
      return;
    }

    FederationServer.resolve(this.destinationAddress)
      .then(value => {
        this.destination = value.account_id;

        if (this.destinationAddress == this.destination) {
          this.stellarAddress = null;
        } else {
          this.stellarAddress = this.destinationAddress;
        }

        switch (value.memo_type) {
          case 'id':
            value.memo_type = 'MEMO_ID';
            break;
          case 'text':
            value.memo_type = 'MEMO_TEXT';
            break;
          case 'hash':
            value.memo_type = 'MEMO_HASH';
            break;
          default:
            delete value.memo;
            delete value.memo_type;
        }

        if (value.memo_type && value.memo) {
          this.memo = true;
          this.memoType = value.memo_type;
          this.memoValue = value.memo;
          this.memoBlocked = true;
        } else {
          this.memoBlocked = false;
          
        }
        this.loadingDestination = false;
        this.$scope.$apply();
      })
      .catch(error => {
        let alert;
        if (this.destinationAddress.indexOf('*') < 0) {
          alert = new Alert({
            title: 'Invalid public key.',
            text: 'Public keys are uppercase and begin with the letter "G."',
            type: Alert.TYPES.ERROR
          });
        } else {
          alert = new Alert({
            title: 'Stellar address cannot be found or is invalid.',
            text: '',
            type: Alert.TYPES.ERROR
          });
        }
        this.addressAlertGroup.show(alert);
        resetState();
        this.$scope.$apply();
      });
  }

  showMemo($event) {
    $event.preventDefault();
    this.memo = true;
    this.memoType = 'MEMO_TEXT';
    this.memoValue = null;
  }

  hideMemo($event) {
    if ($event) {
      $event.preventDefault();
    }
    this.memoAlertGroup.clear();
    this.memo = false;
    this.memoType = null;
    this.memoValue = null;
  }

  showView($event, v) {
    if ($event) {
      $event.preventDefault();
    }
    this.view = v;
  }

  send() {
    if (this.loadingDestination) {
      return false;
    }

    this.sending = true;
    this.addressAlertGroup.clear();
    this.amountAlertGroup.clear();
    this.memoAlertGroup.clear();

    if (!Account.isValidAccountId(this.destination)) {
      let alert = new Alert({
        title: 'Stellar address or public key is invalid.',
        text: 'Public keys are uppercase and begin with the letter "G."',
        type: Alert.TYPES.ERROR
      });
      this.addressAlertGroup.show(alert);
    }

    // Check if amount is valid
    if (!Operation.isValidAmount(this.amount)) {
      let alert = new Alert({
        title: '',
        text: 'This amount is invalid.',
        type: Alert.TYPES.ERROR
      });
      this.amountAlertGroup.show(alert);
    }

    if (this.memo) {
      let memo, memoError;
      try {
        switch (this.memoType) {
          case 'MEMO_TEXT':
            memoError = 'MEMO_TEXT must contain a maximum of 28 characters';
            memo = Memo.text(this.memoValue);
            break;
          case 'MEMO_ID':
            memoError = 'MEMO_ID must be a valid 64 bit unsigned integer';
            memo = Memo.id(this.memoValue);
            break;
          case 'MEMO_HASH':
            memoError = 'MEMO_HASH must be a 32 byte hash represented in hexadecimal (A-Z0-9)';
            memo = Memo.hash(this.memoValue);
            break;
          case 'MEMO_RETURN':
            memoError = 'MEMO_RETURN must be a 32 byte hash represented in hexadecimal (A-Z0-9)';
            memo = Memo.returnHash(this.memoValue);
            break;
        }
      } catch (error) {
        let alert = new Alert({
          title: '',
          text: memoError,
          type: Alert.TYPES.ERROR
        });
        this.memoAlertGroup.show(alert);
      }
    }

    if (this.addressAlerts.length || this.amountAlerts.length || this.memoAlerts.length) {
      this.sending = false;
      return;
    }

    return this.Server.accounts()
      .accountId(this.session.address)
      .call()
      .then(account => {
        // Check if sending this transaction would make balance go below minimum balance
        let minimumBalance = 20 + (account.subentry_count) * 10;
        let nativeBalance = _(account.balances).find(balance => balance.asset_type === 'native').balance;
        let maxSend = new BigNumber(nativeBalance).minus(minimumBalance);
        if (maxSend.lt(this.amount)) {
          throw new BasicClientError('InsufficientBalanceError', {maxSend});
        }
      })
      .then(() => {
        // Check if destination account exists. If no, at least 20 XLM must be sent.
        if (new BigNumber(this.amount).gte(20)) {
          return;
        }

        return this.Server.accounts()
          .accountId(this.destination)
          .call()
          .catch(err => {
            if (err.name === 'NotFoundError') {
              throw new BasicClientError('DestinationAccountNotExistError');
            }
          });
      })
      .then(() => {
        this.displayedAmount = new BigNumber(this.amount).toFormat();
        this.showView(null, 'sendConfirm');
      })
      .catch(err => {
        let alert;
        switch (err.name) {
          case 'NotFoundError':
            alert = new Alert({
              title: '',
              text: 'Your account isn\'t funded.',
              type: Alert.TYPES.ERROR
            });
            break;
          case 'InsufficientBalanceError':
            alert = new Alert({
              title: 'Insufficient balance.',
              text:
                `To maintain your <a href="https://www.stellar.org/developers/learn/concepts/fees.html#minimum-balance" target="_blank">minimum balance</a>, the most you can currently send is ${err.data.maxSend}.`,
              type: Alert.TYPES.ERROR
            });
            break;
          case 'DestinationAccountNotExistError':
            alert = new Alert({
              title: 'Destination account doesn\'t exist.',
              text: 'You account must send at least 20 lumens to create an account.',
              type: Alert.TYPES.ERROR
            });
            break;
          default:
            alert = new Alert({
              title: 'Unknown error: '+err.name,
              text: '',
              type: Alert.TYPES.ERROR
            });
            break;
        }
        this.amountAlertGroup.show(alert);
      })
      .finally(() => {
        this.sending = false;
        this.$scope.$apply();
      });
  }

  confirm() {
    this.showView(null, 'sendWaiting');
    return this.Server.accounts()
      .accountId(this.destination)
      .call()
      .then(() => {
        // Account exist. Send payment operation.
        let operation = Operation.payment({
          destination: this.destination,
          asset: Asset.native(),
          amount: this.amount
        });
        return this._submitTransaction(operation);
      })
      .catch(err => {
        if (err.name === 'NotFoundError') {
          // Account does not exist. Send create_account operation.
          let operation = Operation.createAccount({
            destination: this.destination,
            startingBalance: this.amount
          });
          return this._submitTransaction(operation);
        } else {
          throw err;
        }
      });
  }

  _submitTransaction(operation) {

    return this.Sessions.loadDefaultAccount()
      .then(() => {
        let memo = Memo.none();

        if (this.memo) {
          switch (this.memoType) {
            case 'MEMO_TEXT':
              memo = Memo.text(this.memoValue);
              break;
            case 'MEMO_ID':
              memo = Memo.id(this.memoValue);
              break;
            case 'MEMO_HASH':
              memo = Memo.hash(this.memoValue);
              break;
            case 'MEMO_RETURN':
              memo = Memo.returnHash(this.memoValue);
              break;
          }
        }

        let transaction = new TransactionBuilder(this.session.getAccount())
          .addOperation(operation)
          .addMemo(memo)
          .build();

        if (this.useLedger) {
          let ledgerApi = new StellarLedger.Api(new StellarLedger.comm(120));
          return ledgerApi.signTx_async(this.bip32Path, transaction).then(result => {
            let signature = result['signature'];
            let keyPair = Keypair.fromAccountId(this.session.address);
            let hint = keyPair.signatureHint();
            let decorated = new xdr.DecoratedSignature({hint, signature});
            transaction.signatures.push(decorated);
            return this.Server.submitTransaction(transaction);
          }).catch(e => {
            this.ledgerError = e;
            throw e;
          });
        } else {
          transaction.sign(Keypair.fromSeed(this.session.getSecret()));
          return this.Server.submitTransaction(transaction);
        }
      })
      .then(() => {
        this.success = true;
        this.destinationAddress = null;
        this.destination = null;
        this.amount = null;
        this.memo = false;
        this.$rootScope.$broadcast('account-viewer.transaction-success');
      })
      .catch(e => {
        this.success = false;
        if (this.ledgerError !== null) {
          this.outcomeMessage = this.ledgerError;
        } else {
          this.outcomeMessage = JSON.stringify(e, null, '  ');
        }
      })
      .finally(() => {
        this.showView(null, 'sendOutcome');
        this.$scope.$apply()
      });
  }
}
