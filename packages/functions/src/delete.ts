import { Resource } from "sst";
import { Util } from "@notes/core/util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export const main = Util.handler(async (event) => {
  const params = {
    TableName: Resource.Notes.name,
    Key: {
      userId: event.requestContext.authorizer?.iam.cognitoIdentity.identityId,
      noteId: event?.pathParameters?.id, // The id of the note from the path
    },
  };

  // First, get the note to check for attachments
  const result = await dynamoDb.send(new GetCommand(params));
  
  // If note has an attachment, delete it from S3
  if (result.Item?.attachment) {
    await s3.send(new DeleteObjectCommand({
      Bucket: Resource.Uploads.name,
      Key: result.Item.attachment,
    }));
  }

  // Then delete the note from DynamoDB
  await dynamoDb.send(new DeleteCommand(params));

  return JSON.stringify({ status: true });
});
