import * as utils from "@prague/routerlicious/dist/utils";
import { AsyncQueue, queue } from "async";
import { EventEmitter } from "events";
import { Provider } from "nconf";
import * as winston from "winston";
import { CheckpointManager } from "./checkpointManager";
import { Context } from "./context";
import { IPartitionLambda, IPartitionLambdaFactory } from "./lambdas";

/**
 * Partition of a message stream. Manages routing messages to individual handlers. And then maintaining the
 * overall partition offset.
 */
export class Partition extends EventEmitter {
    private q: AsyncQueue<utils.IMessage>;
    private lambdaP: Promise<IPartitionLambda>;
    private lambda: IPartitionLambda;
    private checkpointManager: CheckpointManager;
    private context: Context;

    constructor(
        id: number,
        factory: IPartitionLambdaFactory,
        consumer: utils.IConsumer,
        config: Provider) {
        super();

        this.checkpointManager = new CheckpointManager(id, consumer);
        this.context = new Context(this.checkpointManager);
        this.context.on("error", (error: any, restart: boolean) => {
            this.emit("error", error, restart);
        });

        this.lambdaP = factory.create(config, this.context);
        this.lambdaP.then(
            (lambda) => {
                this.lambda = lambda;
                this.q.resume();
            },
            (error) => {
                this.emit("error", error, true);
            });

        // Create the incoming message queue
        this.q = queue((message: utils.IMessage, callback) => {
            this.lambda.handler(message);
            callback();
        }, 1);
        this.q.pause();

        this.q.error = (error) => {
            this.emit("error", error, true);
        };
    }

    public process(rawMessage: utils.IMessage) {
        this.q.push(rawMessage);
    }

    public close(): void {
        // Stop any pending message processing
        this.q.kill();

        // Close checkpoint related classes
        this.checkpointManager.close();
        this.context.close();

        // Notify the lambda (should it be resolved) of the close
        this.lambdaP.then(
            (lambda) => {
                lambda.close();
            },
            (error) => {
                // lambda never existed - no need to close
            });

        return;
    }

    /**
     * Stops processing on the partition
     */
    public async drain(): Promise<void> {
        // Drain the queue of any pending operations
        const drainedP = new Promise<void>((resolve, reject) => {
            // If not entries in the queue we can exit immediatley
            if (this.q.length() === 0) {
                winston.info("No pending work exiting early");
                return resolve();
            }

            // Wait until the queue is drained
            winston.info("Waiting for queue to drain");
            this.q.drain = () => {
                winston.info("Drained");
                resolve();
            };
        });
        await drainedP;

        // checkpoint at the latest offset
        await this.checkpointManager.flush();
    }
}
